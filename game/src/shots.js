// shots.js — deterministic screenshot scenes behind ?shot= (A14 Screenshot
// Director). Each scene stages a real sortie (real mission, real flight
// model), flies the plane to the locked pose with a small autopilot at the
// sim's own 120 Hz substep, then freezes time with the camera locked and
// the HUD forced on, so tools/capture.mjs can photograph the exact frame
// the judge will see. Scenes locked in design.md section 8; composition
// per ui_spec.md section 4c (A8 directs appearance). Nothing here edits or
// composites pixels — every screenshot is a live render of the game.
//
// Determinism: world.js, render.js and aircraft.js are all fixed-seed by
// construction, wind is forced calm, and the autopilot integrates at a
// fixed dt with no randomness, so the same ?shot= URL stages the same
// pose every run. The seed query parameter is accepted for manifest
// compatibility with the kit starter pattern.
//
// main.js contract (checked in repo/game/src/main.js): dynamic-imports
// this module when ?shot= is present and calls
// runShotScene(shotName, sim, systems) with
// systems = { renderer, scene, camera, world, aircraft, hud, audio, input }.
// In shot mode main.js stops stepping the sim and stops driving the
// camera, but still syncs aircraft visuals (which would reset cockpit
// visibility from its own camera mode) and renders every frame — so the
// locked camera and visibility are re-asserted inside a renderer.render
// wrapper installed here, the last gate before pixels are drawn.

import * as THREE from 'three';
import { createPlaneState, stepFlight } from './flight.js';
import { startMission, stepMission, dropParcel } from './missions.js';
import { updateCamera } from './render.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIM_STEP_SECONDS = 1 / 120; // matches main.js fixed timestep
const READY_AFTER_FRAMES = 3; // rendered frames before the ready signal
const WORLD_POSE_SECONDS = 2.5; // animated world objects posed at this time

// The four locked scenes (design.md section 8). Aliases let capture use
// either the file stem or the short name.
const SCENE_ALIASES = {
  // The over-land variant won the cover A/B (2026-11-26) and is the
  // shipped cover, so the manifest name stages it; the original
  // over-sea pose stays reachable as 1a-cover-sea.
  '1-chase-ring-dawn': 'coverAlt',
  'chase-ring-dawn': 'coverAlt',
  '1b-cover-alt': 'coverAlt',
  'cover-alt': 'coverAlt',
  '1a-cover-sea': 'chaseRingDawn',
  'cover-sea': 'chaseRingDawn',
  '2-cockpit-final': 'cockpitFinal',
  'cockpit-final': 'cockpitFinal',
  '3-title': 'titleScreen',
  'title': 'titleScreen',
  '3-cargo-drop': 'cargoDrop',
  'cargo-drop': 'cargoDrop',
  '4-tower-takeoff': 'towerTakeoff',
  'tower-takeoff': 'towerTakeoff',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapDegrees180(degrees) {
  let wrapped = degrees % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped < -180) wrapped += 360;
  return wrapped;
}

// Heading 0 = north (-Z), degrees clockwise (interfaces.md).
function headingToForward(headingDeg) {
  const radians = (headingDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(radians), 0, -Math.cos(radians));
}

function headingToRight(headingDeg) {
  const radians = (headingDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(radians), 0, Math.sin(radians));
}

function bearingTo(fromPosition, toPosition) {
  const dx = toPosition.x - fromPosition.x;
  const dz = toPosition.z - fromPosition.z;
  const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

// ---------------------------------------------------------------------------
// Autopilot — flies the real flight model to the pose. A plain PD holder:
// bank toward the target bank (or toward the target heading), pitch toward
// the target pitch (or the pitch that holds target altitude), throttle
// toward the target speed. Deterministic: fixed dt, no randomness.
// ---------------------------------------------------------------------------

function autopilotControls(plane, target) {
  let targetBankDeg = target.bankDeg || 0;
  if (typeof target.headingDeg === 'number') {
    const headingError = wrapDegrees180(target.headingDeg - plane.headingDeg);
    targetBankDeg = clampValue(headingError * 1.1, -30, 30);
  }

  let targetPitchDeg = target.pitchDeg || 0;
  if (typeof target.altitudeMsl === 'number') {
    targetPitchDeg = clampValue(
      2 + (target.altitudeMsl - plane.position.y) * 0.12 - plane.verticalSpeed * 0.6,
      -10,
      14,
    );
  }

  const throttle = typeof target.throttle === 'number'
    ? target.throttle
    : clampValue(0.55 + ((target.speedMps || 40) - plane.airspeed) * 0.04, 0, 1);

  return {
    pitch: clampValue((targetPitchDeg - plane.pitchDeg) / 12, -1, 1),
    roll: clampValue((targetBankDeg - plane.rollDeg) / 25, -1, 1),
    yaw: 0,
    throttle,
    brake: !!target.brake,
    flaps: target.flaps || 0,
  };
}

// Step the real sim for `seconds` under the autopilot. `onStep` may return
// true to stop early (pose reached). Mission stepping is opt-in (only the
// cargo scene needs parcel physics while staging).
function flyAutopilot(sim, world, seconds, target, options) {
  const opts = options || {};
  const steps = Math.round(seconds / SIM_STEP_SECONDS);
  for (let i = 0; i < steps; i++) {
    const controls = typeof target === 'function' ? target(sim.plane) : autopilotControls(sim.plane, target);
    stepFlight(sim.plane, controls, SIM_STEP_SECONDS, world);
    if (opts.stepMissionToo) stepMission(sim, SIM_STEP_SECONDS);
    if (opts.onStep && opts.onStep(sim.plane)) break;
  }
}

// ---------------------------------------------------------------------------
// Shared staging: calm wind, HUD forced on, screens hidden, events cleared
// so no toast can appear in the captured frame.
// ---------------------------------------------------------------------------

function stageCommon(sim, systems, cameraMode, hudMinimal) {
  const { world, hud } = systems;

  // Calm wind everywhere: flight model (world.wind), windsocks (setWind),
  // HUD readout (sim.wind / mission.wind nulled after any mission steps).
  world.wind = { vector: new THREE.Vector3(0, 0, 0) };
  if (typeof world.setWind === 'function') world.setWind(0, 0);

  sim.phase = 'flying';
  sim.forceHud = true;
  sim.hudMinimal = !!hudMinimal;
  sim.cameraMode = cameraMode;
  sim.wind = null;
  if (sim.mission) sim.mission.wind = null;
  sim.events.length = 0;
  if (sim.plane) sim.plane.events.length = 0;

  if (typeof hud.showScreen === 'function') hud.showScreen('none');

  // The input.js "? Help (H)" button sits outside the HUD; hide it so the
  // frame carries only the flight HUD (ui_spec section 4c rule 5).
  const helpButton = document.querySelector('[aria-label="Show controls help"]');
  if (helpButton) helpButton.style.display = 'none';

  // Pose animated world objects (boats, buoys, beacon, ring pulse) at a
  // fixed time so every capture shows the same world.
  if (typeof world.update === 'function') world.update(WORLD_POSE_SECONDS);
}

// HUD target arrow reads mission.target first, then sim.target (hud.js);
// missions publish targetPosition/targetLabel plus a mission.target whose
// distance/bearing are computed when updateNextTarget runs. After
// teleporting the plane those precomputed values are stale, so write a
// fresh target (position + distance + bearing from the frozen pose) to
// both places.
function setHudTarget(sim, label, position) {
  const plane = sim.plane;
  const dx = position.x - plane.position.x;
  const dz = position.z - plane.position.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  let bearingDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;
  const target = { label, position: position.clone(), distance, bearingDeg };
  sim.target = target;
  if (sim.mission) {
    sim.mission.target = target;
    sim.mission.targetPosition = position.clone();
    sim.mission.targetLabel = label;
  }
}

// Replace the plane with a fresh state at the staged spawn. sim.plane is
// read by main.js every frame, so swapping the object is safe.
function respawnPlane(sim, spawn) {
  sim.plane = createPlaneState(spawn);
  return sim.plane;
}

// ---------------------------------------------------------------------------
// Scene 1 (COVER) — chase view, banked 25 degrees threading the next ring
// over the sea west of Aurora: sun low ahead-left, Aurora island ahead-left,
// Signal Hill lighthouse far right. HUD: Ring 3/10, score banked.
// ---------------------------------------------------------------------------

function stageChaseRingDawn(sim, systems) {
  const { world } = systems;
  sim.scene = systems.scene;
  startMission('the-lantern-loop', sim, world); // tier 2 ring course, 10 rings
  const mission = sim.mission;

  // Composition pose (ui_spec 4c: plane centre-left, ring ahead-right,
  // island + sea, full HUD). Heading 130 puts the dawn sun (bearing ~100)
  // ahead-left and the Signal Hill lighthouse far right.
  const headingDeg = 130;
  const altitudeMsl = 130;
  const forward = headingToForward(headingDeg);
  const planeStart = new THREE.Vector3(-1400, altitudeMsl, 600);

  // Visual ring route along the flight line: three done behind, the next
  // ring 55 m ahead of the nose, two more beyond. Radius 10 = tier 2.
  const routeOffsets = [-600, -350, -150, 55, 400, 800];
  const route = routeOffsets.map((offset) => {
    const point = planeStart.clone().addScaledVector(forward, offset);
    return { x: point.x, z: point.z, agl: altitudeMsl };
  });
  world.placeRings(route, 10);
  world.setRingState(world.rings[0], 'done');
  world.setRingState(world.rings[1], 'done');
  world.setRingState(world.rings[2], 'done');
  world.setRingState(world.rings[3], 'next');
  world.setRingState(world.rings[4], 'todo');
  world.setRingState(world.rings[5], 'todo');
  const nextRing = world.rings[3];

  respawnPlane(sim, {
    position: planeStart.clone().addScaledVector(forward, -12),
    headingDeg,
    pitchDeg: 2,
    rollDeg: 25,
    airspeed: 40,
    verticalSpeed: 1.5,
    throttle: 0.62,
    fuel: 0.82,
    damage: 0,
    flaps: 0,
    onGround: false,
  });

  // Settle into the pose under the autopilot: hold the 25-degree bank,
  // gentle climb, cruise speed. Freeze with the ring just ahead.
  flyAutopilot(sim, world, 1.2, {
    bankDeg: 25,
    pitchDeg: 2,
    speedMps: 40,
    flaps: 0,
  }, {
    onStep: (plane) => plane.position.distanceTo(nextRing.position) < 58,
  });

  mission.ringsHit = 3;
  mission.nextRingIndex = 3;
  mission.progressText = 'Ring 3/10';
  mission.objective = 'Thread the rings in order — ring 4 of 10.';
  mission.score = 1150;
  sim.score = 1150;
  sim.time = 187;
  setHudTarget(sim, 'Ring 4', nextRing.position);

  stageCommon(sim, systems, 'chase', false);
  return { cameraMode: 'chase', yawOffsetDeg: -9, dollyInMetres: 1.5 };
}

// ---------------------------------------------------------------------------
// Scene 1B (COVER ALT, A/B variant) — same cover pose as scene 1 (chase,
// banked 25 degrees threading the green ring, sun low ahead-left, same
// HUD) but staged OVER LAND: the plane flies south-east across Aurora
// island with Aurora Field's pale runway strip ahead-left in the lower
// frame, so terrain + runway + ring + aircraft share one frame
// (criterion-1 hardening vs terrain-filled rival covers; A2 tournament
// report section 5, risk 2). This variant won the A/B at judge size
// (2026-11-26) and ships as screenshots/1-chase-ring-dawn.jpg; capture
// via ?shot=1-chase-ring-dawn or ?shot=1b-cover-alt.
// ---------------------------------------------------------------------------

function stageCoverAlt(sim, systems) {
  const { world } = systems;
  sim.scene = systems.scene;
  startMission('the-lantern-loop', sim, world); // tier 2 ring course, 10 rings
  const mission = sim.mission;

  // Same heading as scene 1: heading 130 keeps the dawn sun
  // (bearing ~100) ahead-left. VD6-23 restage (Agent 6 V6-SHOTS):
  // altitude 130 → 118 and lateral offset 170 → 135 m so the strip
  // sits nearer the flight line with a shallower depression angle —
  // the "09" threshold was clipped by the bottom-left frame corner
  // and the hangar crowded under the left HUD column. The plane
  // starts 340 m short of Aurora Field and 135 m to its right
  // (south-west of the strip), strip ahead-left, low in frame.
  const headingDeg = 130;
  const altitudeMsl = 118;
  const forward = headingToForward(headingDeg);
  const right = headingToRight(headingDeg);
  const homeStrip = world.strips[0];
  const planeStart = new THREE.Vector3(homeStrip.centre.x, altitudeMsl, homeStrip.centre.z)
    .addScaledVector(forward, -340)
    .addScaledVector(right, 135);

  // Same visual ring route as scene 1 along the flight line. Each
  // waypoint carries an explicit position.y: placeRings() otherwise
  // stacks rings at ground + AGL, which over land would float the hoop
  // ~30 m above the plane instead of at its altitude.
  // VD-01 restage (agent 19, visual_spec §6 shot 1): the next ring sits
  // ~100 m ahead of the nose at freeze (was 55 m — wing crossed it and
  // the flight-path marker sat inside its disc) and the route bends
  // right of the flight line so the ring reads ahead-right with sky/sea
  // behind it, clear of the banked wing.
  // VD6-07 camera share (Agent 6 V6-SHOTS): bend deepened 18 → 26 m
  // right and the ring pushed to 128 m so the banked wing's trailing
  // edge clears the hoop's lower-left quadrant at judge size.
  const routeOffsets = [-600, -350, -150, 128, 420, 820];
  const routeRightOffsets = [0, 0, 0, 26, 12, 6];
  const route = routeOffsets.map((offset, index) => {
    const point = planeStart.clone()
      .addScaledVector(forward, offset)
      .addScaledVector(right, routeRightOffsets[index]);
    return {
      x: point.x,
      z: point.z,
      agl: altitudeMsl,
      position: new THREE.Vector3(point.x, altitudeMsl, point.z),
    };
  });
  world.placeRings(route, 10);
  world.setRingState(world.rings[0], 'done');
  world.setRingState(world.rings[1], 'done');
  world.setRingState(world.rings[2], 'done');
  world.setRingState(world.rings[3], 'next');
  world.setRingState(world.rings[4], 'todo');
  world.setRingState(world.rings[5], 'todo');
  const nextRing = world.rings[3];

  respawnPlane(sim, {
    position: planeStart.clone().addScaledVector(forward, -12),
    headingDeg,
    pitchDeg: 2,
    rollDeg: 25,
    airspeed: 40,
    verticalSpeed: 1.5,
    throttle: 0.62,
    fuel: 0.82,
    damage: 0,
    flaps: 0,
    onGround: false,
  });

  // Same settle as scene 1: hold the 25-degree bank, gentle climb,
  // cruise speed, freeze with the ring ~105 m ahead (VD-01, §6: 90–110 m).
  flyAutopilot(sim, world, 1.2, {
    bankDeg: 25,
    pitchDeg: 2,
    speedMps: 40,
    flaps: 0,
  }, {
    onStep: (plane) => plane.position.distanceTo(nextRing.position) < 106,
  });

  mission.ringsHit = 3;
  mission.nextRingIndex = 3;
  mission.progressText = 'Ring 3/10';
  mission.objective = 'Thread the rings in order — ring 4 of 10.';
  mission.score = 1150;
  sim.score = 1150;
  sim.time = 187;
  setHudTarget(sim, 'Ring 4', nextRing.position);

  stageCommon(sim, systems, 'chase', false);
  // VD-07 framing (agent 16): with the rear-three-quarter chase offset in
  // render.js, pull back 1 m (plane 40–50% of frame height, was ~60%
  // wing-diagonal) and shift the camera 1.5 m right so parallax puts the
  // near plane centre-left while the distant ring/strip stay put.
  // VD6-23 (Agent 6 V6-SHOTS): yaw −9 → −6 (view eased left so the
  // runway threshold clears the frame corner; plane stays centre-left)
  // and dolly −3.0 → −2.2 (plane back up to ~50% of frame height).
  return {
    cameraMode: 'chase',
    yawOffsetDeg: -6,
    dollyInMetres: -2.2,
    rightMetres: 1.5,
  };
}

// ---------------------------------------------------------------------------
// Scene 2 — cockpit on final to Aurora Field: lit six-pack, runway and
// approach lights ahead through the windscreen, full flap, on speed.
// ---------------------------------------------------------------------------

function stageCockpitFinal(sim, systems) {
  const { world } = systems;
  sim.scene = systems.scene;
  startMission('first-light', sim, world); // precision landing, Aurora Field
  const mission = sim.mission;

  const homeStrip = world.strips[0];
  const stripElevation = world.heightAt(homeStrip.centre.x, homeStrip.centre.z);
  const stripForward = headingToForward(homeStrip.headingDeg); // 90, east
  const stripRight = headingToRight(homeStrip.headingDeg);
  const threshold = new THREE.Vector3(
    homeStrip.centre.x - stripForward.x * (homeStrip.length / 2),
    stripElevation,
    homeStrip.centre.z - stripForward.z * (homeStrip.length / 2),
  );

  // VD-02 restage (agent 19, visual_spec §6 shot 2): final heading
  // offset off the sun axis. The dawn sun bears ~100°, so flying the
  // strip heading (090°) puts the disc dead centre over the runway.
  // VD6-04 camera share (Agent 6 V6-SHOTS): the 112° / 55 m-north
  // staging left the strip a thin sliver left of the hangar at judge
  // size (lateral closure only ~9 m in the 1 s settle). Restage from
  // the SOUTH-west instead: 30 m south of the extended centreline on
  // heading 079°, converging on the threshold. At freeze the
  // threshold bears ~078° (dead ahead over the glareshield, strip
  // centreline reading down the frame) while the sun at ~100° sits
  // ~21° right of the nose — clear of the strip axis. Freeze
  // ~120 m from the threshold, 24 m above the strip.
  const headingDeg = homeStrip.headingDeg - 11; // 079
  const startPosition = threshold.clone()
    .addScaledVector(stripForward, -145)
    .addScaledVector(stripRight, 30); // 30 m south of the centreline
  startPosition.y = stripElevation + 24;
  respawnPlane(sim, {
    position: startPosition,
    headingDeg,
    pitchDeg: -4,
    rollDeg: 0,
    airspeed: 25,
    verticalSpeed: -2,
    throttle: 0.32,
    fuel: 0.64,
    damage: 0,
    flaps: 2,
    onGround: false,
  });

  // Fly a short stabilised final on the offset heading, then freeze.
  flyAutopilot(sim, world, 1.0, (plane) => autopilotControls(plane, {
    headingDeg,
    pitchDeg: -4,
    speedMps: 25,
    throttle: 0.32,
    flaps: 2,
  }));

  sim.score = 0;
  sim.time = 95;
  // Target = the threshold aim point, so the HUD distance (~120 m)
  // agrees with the frozen pose (§6 shot 2 checklist).
  setHudTarget(sim, 'Aurora Field', threshold);

  stageCommon(sim, systems, 'cockpit', true);
  // True eye point: the visors are stowed flat in aircraft.js (D-13),
  // so the old (0, -0.18, 0.14) workaround offset is gone.
  return { cameraMode: 'cockpit' };
}

// ---------------------------------------------------------------------------
// Scene 3 — cargo drop at Widow's Reef: parcel just released under its
// parachute, falling toward the marked zone while the plane climbs away.
// ---------------------------------------------------------------------------

function stageCargoDrop(sim, systems) {
  const { world } = systems;
  sim.scene = systems.scene;
  startMission('far-shore-post', sim, world); // tier 2 cargo, 4 zones
  const mission = sim.mission;

  // Two parcels delivered, now working the Widow's Reef zone (index 3).
  mission.activeZoneIndex = 3;
  mission.parcelsDelivered = 2;
  mission.parcelsAboard = 2;
  mission.progressText = 'Parcels 2/4';
  mission.objective = "Drop a parcel on the marked zone at Widow's Reef.";
  mission.score = 1600;
  sim.score = 1600;
  sim.time = 264;

  const zone = mission.dropZones[3];
  const zonePosition = zone.position;
  // VD-03 restage (agent 19, visual_spec §6 shot 3): run-in heading
  // rotated to west (270°) so the dawn sun (bearing ~100°) sits behind
  // the camera and out of frame — the old 135° run-in put a white
  // glare column behind the ALT panel and backlit the parcel. The
  // camera sees the sun-lit side of plane and parcel.
  // VD6-03 restage (Agent 6 V6-SHOTS): cruise altitude zone+115 →
  // zone+42. At +115 the plane→parcel→zone stack spans 115 m
  // vertically and no single frame can hold all three (the shipped
  // shot cropped the plane out of the top and hid the canopy behind
  // the target panel). At +42 the stack fits one frame with the
  // parcel still ~35 m above the zone at freeze.
  const headingDeg = 270; // west: sun behind camera, lit side to camera
  const forward = headingToForward(headingDeg);
  const cruiseAltitudeMsl = zonePosition.y + 42;

  const startPosition = zonePosition.clone().addScaledVector(forward, -280);
  startPosition.y = cruiseAltitudeMsl;
  respawnPlane(sim, {
    position: startPosition,
    headingDeg,
    pitchDeg: 1,
    rollDeg: 0,
    airspeed: 30,
    verticalSpeed: 0,
    throttle: 0.55,
    fuel: 0.71,
    damage: 0.08,
    flaps: 0,
    onGround: false,
  });

  // Run in toward the zone, release 58 m short, then climb gently away
  // while the parcel falls under its canopy (mission stepping drives
  // parcels). Freeze 1.15 s after release (VD6-03, Agent 6 V6-SHOTS;
  // was 140 m short / pitch 6 / throttle 0.85 / freeze 1.8 s — the
  // plane climbed out of the top of frame and the parcel drifted
  // ~100 m from the zone). At 1.15 s the canopy has just opened
  // (chute delay 1.0 s), the parcel is only ~4 m behind and ~8 m
  // below the plane, and the zone X is ~24 m ahead of the plane —
  // one tight group that fits a single frame.
  let released = false;
  flyAutopilot(sim, world, 14, (plane) => {
    const toZone = bearingTo(plane.position, zonePosition);
    const horizontalDistance = Math.hypot(
      zonePosition.x - plane.position.x,
      zonePosition.z - plane.position.z,
    );
    if (!released && horizontalDistance < 58) {
      dropParcel(sim);
      released = true;
    }
    if (released) {
      return autopilotControls(plane, {
        headingDeg,
        pitchDeg: 4,
        speedMps: 30,
        throttle: 0.72,
        flaps: 0,
      });
    }
    return autopilotControls(plane, {
      headingDeg: toZone,
      altitudeMsl: cruiseAltitudeMsl,
      speedMps: 30,
      flaps: 0,
    });
  }, {
    stepMissionToo: true,
    onStep: () => released && mission.parcels.length > 0 && mission.parcels[0].age > 1.15,
  });

  setHudTarget(sim, "Widow's Reef", zonePosition);
  stageCommon(sim, systems, 'chase', false);
  // VD6-03 restage (Agent 6 V6-SHOTS): elevated rear-quarter from the
  // south-east (sun-lit side; sun behind camera on the 270° run-in),
  // 21 m behind the plane, 8 m south of track, 6 m above it. The
  // look point sits between parcel and zone, biased north and up so
  // the composition lands in the panel-free corridors: plane
  // upper-left (clear of the HDG/score/objective stack), canopy+crate
  // in profile at centre, zone X lower-left-centre (clear of the
  // bottom-centre target panel). Was: 18 m behind / 7 m right / +5 m,
  // lookAt lerp 0.45 — plane cropped out of the top, canopy hidden
  // behind the target panel, crate invisible.
  const planePosition = sim.plane.position;
  const parcelPosition = mission.parcels.length > 0
    ? mission.parcels[0].position
    : planePosition;
  const right = headingToRight(headingDeg);
  const cameraPosition = planePosition.clone()
    .addScaledVector(forward, -21)
    .addScaledVector(right, -8)
    .add(new THREE.Vector3(0, 6, 0));
  const lookAtPoint = parcelPosition.clone().lerp(zonePosition, 0.20)
    .addScaledVector(right, 11)
    .add(new THREE.Vector3(0, 4, 0));
  return {
    cameraMode: 'chase',
    fixedCameraPosition: cameraPosition,
    fixedLookAt: lookAtPoint,
    fov: 62,
  };
}

// ---------------------------------------------------------------------------
// Scene 4 — tower view: rotating off Aurora Field at dawn, hangar, tower
// and fuel drums in frame, gear down, island and sea behind.
// ---------------------------------------------------------------------------

function stageTowerTakeoff(sim, systems) {
  const { world } = systems;
  sim.scene = systems.scene;
  startMission('thread-the-dawn', sim, world); // just launched, score 0
  const mission = sim.mission;

  const homeStrip = world.strips[0];
  const stripElevation = world.heightAt(homeStrip.centre.x, homeStrip.centre.z);
  const headingDeg = homeStrip.headingDeg;
  const forward = headingToForward(headingDeg);
  const right = headingToRight(headingDeg);

  // User order 2026-11-27: takeoff moment NEXT TO THE CABIN/hangar, side
  // profile clear, plane large, framing as beautiful as possible.
  // The airfield-dressing hangar sits at stripPoint(-30, +55) — 30 m behind
  // the centre, 55 m on the +right (apron) side — so the camera goes on
  // the -right side looking across the strip: plane broadside in front,
  // hangar behind it, dawn sky above, runway lights leading away.
  // Composition knobs are URL params so candidate captures can vary them
  // without code edits: spawn (along-offset of the roll start), freezeAlt,
  // camdist, camh (camera height above the plane), camalong (camera
  // along-offset, + = ahead of the plane), looklead, fov, hudmin.
  const params = new URLSearchParams(window.location.search);
  const num = (key, fallback) => {
    const value = Number(params.get(key));
    return Number.isFinite(value) && params.has(key) ? value : fallback;
  };
  const spawnAlong = num('spawn', -(homeStrip.length / 2 - 15));
  const freezeAlt = num('freezeAlt', 4.5);
  const camDist = num('camdist', 17);
  const camHeight = num('camh', 2.5);
  const camAlong = num('camalong', 3);
  const lookLead = num('looklead', 3);
  const fov = num('fov', 50);
  const hudMinimal = num('hudmin', 1) !== 0;

  // Parked at the threshold, then a real takeoff roll under the autopilot:
  // full throttle, rotate at 22 m/s, freeze just after liftoff.
  const threshold = new THREE.Vector3(homeStrip.centre.x, stripElevation, homeStrip.centre.z)
    .addScaledVector(forward, spawnAlong);
  respawnPlane(sim, {
    position: new THREE.Vector3(threshold.x, stripElevation + 1.1, threshold.z),
    headingDeg,
    pitchDeg: 0,
    rollDeg: 0,
    airspeed: 0,
    verticalSpeed: 0,
    throttle: 0,
    fuel: 0.98,
    damage: 0,
    flaps: 1,
    onGround: true,
  });

  flyAutopilot(sim, world, 14, (plane) => {
    const rotating = plane.airspeed > 22;
    return {
      pitch: rotating ? 0.4 : 0,
      roll: 0,
      yaw: 0,
      throttle: 1,
      brake: false,
      flaps: 1,
    };
  }, {
    onStep: (plane) => !plane.onGround && plane.altitudeAgl > freezeAlt,
  });

  sim.score = 0;
  sim.time = 12;
  mission.progressText = 'Ring 0/8';
  if (mission.rings && mission.rings[0]) {
    setHudTarget(sim, 'Ring 1', mission.rings[0].position);
  }

  stageCommon(sim, systems, 'tower', hudMinimal);

  // Broadside camera on the -right side: plane large in frame at liftoff
  // (gear down, nose up), hangar behind it across the strip, runway band
  // and dawn gradient filling the rest. Look point a touch ahead of the
  // plane keeps it off dead-centre (rule of thirds).
  const planePosition = sim.plane.position;
  const cameraPosition = planePosition.clone()
    .addScaledVector(right, -camDist)
    .addScaledVector(forward, camAlong);
  cameraPosition.y = planePosition.y + camHeight;
  const lookAtPoint = planePosition.clone().addScaledVector(forward, lookLead);
  lookAtPoint.y = planePosition.y - 0.5;
  return {
    cameraMode: 'tower',
    fixedCameraPosition: cameraPosition,
    fixedLookAt: lookAtPoint,
    fov,
  };
}

// ---------------------------------------------------------------------------
// Camera lock — re-asserted inside the render wrapper every frame because
// main.js re-syncs aircraft visibility (and would otherwise own the
// camera) before each render.
// ---------------------------------------------------------------------------

function lockShotCamera(sim, systems, cameraPlan) {
  const { camera, aircraft, world } = systems;
  const plane = sim.plane;

  if (cameraPlan.fixedCameraPosition) {
    camera.position.copy(cameraPlan.fixedCameraPosition);
    camera.lookAt(cameraPlan.fixedLookAt || plane.position);
    if (cameraPlan.fov) {
      camera.fov = cameraPlan.fov;
      camera.updateProjectionMatrix();
    }
  } else {
    // First updateCamera call snaps (camera state starts uninitialised).
    updateCamera(camera, plane, cameraPlan.cameraMode, 0.1, world);

    if (cameraPlan.localOffset) {
      camera.position.add(
        cameraPlan.localOffset.clone().applyQuaternion(plane.quaternion),
      );
    }
    if (cameraPlan.raiseMetres) {
      camera.position.y += cameraPlan.raiseMetres;
    }
    if (cameraPlan.rightMetres) {
      const rightVector = new THREE.Vector3(1, 0, 0).applyQuaternion(plane.quaternion);
      camera.position.addScaledVector(rightVector, cameraPlan.rightMetres);
    }
    if (cameraPlan.dollyInMetres) {
      const towardPlane = plane.position.clone().sub(camera.position).normalize();
      camera.position.addScaledVector(towardPlane, cameraPlan.dollyInMetres);
    }
    if (cameraPlan.lookAtPoint) {
      const blend = cameraPlan.lookAtBlend || 0.3;
      const lookTarget = plane.position.clone().lerp(cameraPlan.lookAtPoint, blend);
      camera.lookAt(lookTarget);
    }
    if (cameraPlan.yawOffsetDeg) {
      // Yaw the camera right so the plane sits centre-left (ui_spec 4c).
      const yaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(cameraPlan.yawOffsetDeg),
      );
      camera.quaternion.premultiply(yaw);
    }
  }

  const lockedPosition = camera.position.clone();
  const lockedQuaternion = camera.quaternion.clone();
  const lockedFov = camera.fov;
  const cockpitView = cameraPlan.cameraMode === 'cockpit';

  const originalRender = systems.renderer.render.bind(systems.renderer);
  let renderedFrames = 0;
  systems.renderer.render = (scene, renderCamera) => {
    renderCamera.position.copy(lockedPosition);
    renderCamera.quaternion.copy(lockedQuaternion);
    if (renderCamera.fov !== lockedFov) {
      renderCamera.fov = lockedFov;
      renderCamera.updateProjectionMatrix();
    }
    aircraft.group.visible = !cockpitView;
    if (aircraft.cockpit) aircraft.cockpit.visible = cockpitView;
    // User order 2026-11-27: no side wings from the seat — hide the
    // nose-view wing copies in the cockpit shot, restore otherwise.
    if (aircraft.cockpitWingCopies) aircraft.cockpitWingCopies.visible = !cockpitView;
    originalRender(scene, renderCamera);
    renderedFrames += 1;
    // Perf evidence for the audit wave: draw calls + triangles per frame.
    const renderInfo = systems.renderer.info && systems.renderer.info.render;
    if (renderInfo) {
      window.__auroraShotRenderInfo = {
        calls: renderInfo.calls,
        triangles: renderInfo.triangles,
        frame: renderedFrames,
      };
    }
    if (renderedFrames >= READY_AFTER_FRAMES && !window.__auroraShotReady) {
      window.__auroraShotReady = true;
    }
  };
}

// Title screen (user order 2026-11-27: title replaces cargo in the judged
// set). The boot sequence already shows the title screen; this stager only
// parks the plane on the home strip and locks a backdrop camera so the
// capture shows the live dawn scene behind the title UI. No mission is
// started and the phase stays 'menu', so the flight HUD stays hidden.
function stageTitleScreen(sim, systems) {
  const { world } = systems;
  sim.scene = systems.scene;
  sim.phase = 'menu';

  const homeStrip = world.strips[0];
  const stripElevation = world.heightAt(homeStrip.centre.x, homeStrip.centre.z);
  const headingDeg = homeStrip.headingDeg;
  const forward = headingToForward(headingDeg);
  const right = headingToRight(headingDeg);

  const threshold = new THREE.Vector3(homeStrip.centre.x, stripElevation, homeStrip.centre.z)
    .addScaledVector(forward, -(homeStrip.length / 2 - 15));
  respawnPlane(sim, {
    position: new THREE.Vector3(threshold.x, stripElevation + 1.1, threshold.z),
    headingDeg,
    pitchDeg: 0,
    rollDeg: 0,
    airspeed: 0,
    verticalSpeed: 0,
    throttle: 0,
    fuel: 0.98,
    damage: 0,
    flaps: 1,
    onGround: true,
  });

  sim.score = 0;
  sim.time = 0;

  // Backdrop camera: off the strip's right shoulder, looking back along the
  // runway so the parked plane and dawn sky sit centre-frame behind the UI.
  const cameraPosition = threshold.clone()
    .addScaledVector(right, 16)
    .addScaledVector(forward, -6);
  cameraPosition.y = stripElevation + 5;
  const lookTarget = threshold.clone().addScaledVector(forward, 30);
  lookTarget.y = stripElevation + 2;

  return {
    cameraMode: 'tower',
    fixedCameraPosition: cameraPosition,
    fixedLookAt: lookTarget,
  };
}

// ---------------------------------------------------------------------------
// Entry point called by main.js: runShotScene(name, sim, systems)
// ---------------------------------------------------------------------------

export function runShotScene(name, sim, systems) {
  const sceneKey = SCENE_ALIASES[name] || 'chaseRingDawn';
  const stagers = {
    chaseRingDawn: stageChaseRingDawn,
    coverAlt: stageCoverAlt,
    cockpitFinal: stageCockpitFinal,
    titleScreen: stageTitleScreen,
    cargoDrop: stageCargoDrop,
    towerTakeoff: stageTowerTakeoff,
  };

  const cameraPlan = stagers[sceneKey](sim, systems);
  lockShotCamera(sim, systems, cameraPlan);

  // Diagnostics for capture.mjs (pose summary, no personal data).
  const plane = sim.plane;
  window.__auroraShotInfo = {
    scene: name,
    position: {
      x: Math.round(plane.position.x),
      y: Math.round(plane.position.y),
      z: Math.round(plane.position.z),
    },
    headingDeg: Math.round(plane.headingDeg),
    pitchDeg: Math.round(plane.pitchDeg),
    rollDeg: Math.round(plane.rollDeg),
    airspeed: Math.round(plane.airspeed),
    altitudeAgl: Math.round(plane.altitudeAgl),
    fuelPercent: Math.round(plane.fuel * 100),
    damagePercent: Math.round(plane.damage * 100),
    throttlePercent: Math.round(plane.throttle * 100),
    onGround: plane.onGround,
    score: sim.score,
  };
}
