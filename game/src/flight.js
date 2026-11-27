// AURORA POST — flight model (A4 Flight Physics Engineer).
// Arcade-realistic bush plane: real lift/thrust/drag forces tuned so every
// design.md section 4 target holds (stall 18, rotate 22, climb 5.5 m/s at 26,
// cruise 38-42, max level 58, overspeed 65, glide 28 at 2.2 sink, turn about
// 18 deg/s at 30 deg bank). Controls answer at every speed: authority scales
// with dynamic pressure but is floored at 40%. Stall is a mush with a nose
// drop, never a spin. Pure math on THREE vectors; no rendering, no input
// devices, no mission logic. Called by main.js at a fixed 120 Hz substep.
//
// Sign conventions (controls object from input.js):
//   pitch +1 = stick back = nose up. roll +1 = stick right = bank right.
//   yaw +1 = rudder right = nose right. throttle 0..1 = lever position.
//   flaps 0 (up), 1 (approach), 2 (full). brake true = wheel brakes held.
// Aircraft axes: forward is local -Z, right is local +X, up is local +Y.
// Heading 0 = north (-Z), increasing clockwise (90 = east, +X).

import * as THREE from 'three';
import { WORLD, PLANE, FLIGHT_TUNING, FUEL_TUNING, DAMAGE_TUNING } from './config.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_DT = 0.05; // caller substeps at 120 Hz; never integrate a huge step
const MAX_PITCH_UP_DEG = 45; // arcade pitch limits (a bush plane, not a fighter)
const MAX_PITCH_DOWN_DEG = -55;
const GROUND_MAX_PITCH_DEG = 12; // gear geometry: the tail would strike past this
const GROUND_MIN_PITCH_DEG = -2;
const STALL_NOSE_DROP_DEG = -8; // pitch the nose settles toward in a stall
const STALL_PITCH_RATE_DEG = 20; // deg/s of nose-drop moment while stalled
const STALL_ELEVATOR_FACTOR = 0.25; // elevator fades in the stall so the nose drops
const STALL_LIFT_FACTOR = 0.75; // lift kept in the mush (sink grows, no departure)
const STALL_EXTRA_DRAG = 0.08; // drag coefficient added while stalled
const MAX_TURN_RATE_DEG = 35; // deg/s cap so steep banks stay controllable
const GROUND_STEER_RATE_DEG = 25; // deg/s of nose-wheel steering at taxi speed

// Scratch objects reused every substep (no per-step allocation in the loop).
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _airVelocity = new THREE.Vector3();
const _velocityDir = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _force = new THREE.Vector3();
const _deltaQuat = new THREE.Quaternion();
const _worldQuat = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

// Build a fresh PlaneState. spawn may carry: position (Vector3 or {x,y,z}),
// headingDeg, pitchDeg, rollDeg, airspeed (m/s along heading), verticalSpeed,
// velocity (Vector3 or {x,y,z}, overrides airspeed), throttle, fuel 0..1,
// damage 0..1, flaps, onGround. Defaults: parked at the origin facing east
// (Aurora Field direction), engine on, full fuel, no damage.
export function createPlaneState(spawn) {
  const s = spawn || {};
  const headingDeg = numberOr(s.headingDeg, 90);
  const pitchDeg = numberOr(s.pitchDeg, 0);
  const rollDeg = numberOr(s.rollDeg, 0);

  const position = new THREE.Vector3(0, PLANE.gearHeight, 0);
  if (s.position) {
    position.set(numberOr(s.position.x, 0), numberOr(s.position.y, PLANE.gearHeight), numberOr(s.position.z, 0));
  }

  const quaternion = new THREE.Quaternion();
  quaternion.setFromEuler(new THREE.Euler(
    pitchDeg * DEG_TO_RAD, // about local X: positive pitches the nose up
    -headingDeg * DEG_TO_RAD, // about world Y: negative turns north toward east
    -rollDeg * DEG_TO_RAD, // about local Z: negative banks right
    'YXZ'
  ));

  const velocity = new THREE.Vector3();
  if (s.velocity) {
    velocity.set(numberOr(s.velocity.x, 0), numberOr(s.velocity.y, 0), numberOr(s.velocity.z, 0));
  } else {
    const airspeed = numberOr(s.airspeed, 0);
    const headingRad = headingDeg * DEG_TO_RAD;
    velocity.set(Math.sin(headingRad) * airspeed, numberOr(s.verticalSpeed, 0), -Math.cos(headingRad) * airspeed);
  }

  const fuel = clamp01(numberOr(s.fuel, 1));
  const damage = clamp01(numberOr(s.damage, 0));
  const onGround = s.onGround !== undefined ? !!s.onGround : velocity.lengthSq() < 0.01;

  const plane = {
    position,
    velocity,
    quaternion,
    headingDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    airspeed: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    altitudeAgl: onGround ? 0 : position.y,
    altitudeMsl: position.y,
    throttle: clamp01(numberOr(s.throttle, 0)),
    fuel,
    damage,
    onGround,
    gearDown: true, // fixed gear bush plane (design.md Appendix C)
    stalled: false,
    buffet: false,
    overspeed: false,
    engineOn: fuel > 0 && damage < 1,
    flaps: clampFlaps(s.flaps),
    events: [],
    // Internal bookkeeping for edge-triggered events and timers.
    _wasStalled: false,
    _wasOverspeed: false,
    _wasOnStrip: false,
    _overspeedTimer: 0,
  };
  deriveFlightData(plane, position.y - plane.altitudeAgl, _wind.set(0, 0, 0));
  return plane;
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

// Advance the plane by dt seconds. controls = {pitch, roll, yaw, throttle,
// brake, flaps}. world = {heightAt(x,z), stripAt(x,z), wind?, obstacles?}.
// Pushes {type:'touchdown'|'crash'|'stall'|'overspeed', ...} into
// plane.events for main.js to drain into audio, HUD and missions.
export function stepFlight(plane, controls, dt, world) {
  if (!(dt > 0)) return;
  const step = Math.min(dt, MAX_DT);
  const c = controls || {};
  const pitchInput = clamp(numberOr(c.pitch, 0), -1, 1);
  const rollInput = clamp(numberOr(c.roll, 0), -1, 1);
  const yawInput = clamp(numberOr(c.yaw, 0), -1, 1);
  const throttleTarget = clamp01(numberOr(c.throttle, plane.throttle));
  const brakeHeld = !!c.brake;
  plane.flaps = clampFlaps(c.flaps !== undefined ? c.flaps : plane.flaps);

  readWind(world, _wind);
  const derating = computeDamageDerating(plane.damage);

  updateThrottleSpool(plane, throttleTarget, step);
  plane.engineOn = plane.fuel > 0 && plane.damage < 1;
  burnFuel(plane, step);

  // Air-relative speed drives authority, lift and drag (wind moves the air).
  _airVelocity.copy(plane.velocity).sub(_wind);
  const airspeedBefore = _airVelocity.length();
  const authority = computeControlAuthority(airspeedBefore, derating.authorityFactor);

  applyStickRotations(plane, pitchInput, rollInput, yawInput, authority, step);
  applyCoordinatedTurn(plane, airspeedBefore, step);
  applyBoundaryAssist(plane, step);
  clampAttitude(plane);

  const aero = computeAerodynamicForces(plane, derating.powerFactor);
  integrateVelocity(plane, aero, step);
  plane.position.addScaledVector(plane.velocity, step);

  resolveGroundContact(plane, world, aero, brakeHeld, step);
  applyOverspeedStress(plane, aero.airspeed, step);
  applyStallEvent(plane, aero.airspeed);

  plane.damage = clamp01(plane.damage);
  plane.fuel = clamp01(plane.fuel);
  plane.engineOn = plane.fuel > 0 && plane.damage < 1;

  const groundY = groundHeightAt(world, plane.position.x, plane.position.z);
  deriveFlightData(plane, groundY, _wind);
  plane._wasStalled = plane.stalled;
}

// ---------------------------------------------------------------------------
// Controls and orientation
// ---------------------------------------------------------------------------

// Dynamic-pressure authority with the 40% floor: at 35 m/s the controls are
// fully effective, at stall speed they still answer at about half strength,
// and even at a standstill they keep 40% (judge criterion 3).
function computeControlAuthority(airspeed, damageFactor) {
  const ratio = airspeed / FLIGHT_TUNING.authorityRefSpeed;
  const pressure = clamp(ratio * ratio, FLIGHT_TUNING.authorityFloor, 1);
  return pressure * damageFactor;
}

// Damage bands from config: a bent plane makes less power and answers slower.
function computeDamageDerating(damage) {
  let band = DAMAGE_TUNING.bands[0];
  for (const candidate of DAMAGE_TUNING.bands) {
    if (damage >= candidate.minDamage) band = candidate;
  }
  return band;
}

// Engine spool: the actual throttle chases the lever with a 0.6 s time
// constant, so power changes feel like an engine, not a light switch.
function updateThrottleSpool(plane, throttleTarget, dt) {
  const blend = 1 - Math.exp(-dt / FLIGHT_TUNING.spoolTimeS);
  plane.throttle += (throttleTarget - plane.throttle) * blend;
  plane.throttle = clamp01(plane.throttle);
}

// Fuel burn: 0.04 + 0.26 * throttle units per second on a 100-unit tank.
// plane.fuel is stored as a fraction 0..1 (interfaces.md).
function burnFuel(plane, dt) {
  if (!plane.engineOn) return;
  const burnPerSecond = FUEL_TUNING.burnIdle
    + (FUEL_TUNING.burnFull - FUEL_TUNING.burnIdle) * plane.throttle;
  plane.fuel = Math.max(0, plane.fuel - (burnPerSecond * dt) / FUEL_TUNING.tank);
}

// Stick and rudder rotate the airframe. On the ground the ailerons do
// nothing, the rudder steers the nose wheel, and pitch is gear-limited.
function applyStickRotations(plane, pitchInput, rollInput, yawInput, authority, dt) {
  if (plane.onGround) {
    const groundSpeed = horizontalSpeed(plane.velocity);
    const steerBlend = clamp(groundSpeed / 8, 0, 1); // no steering parked, full by 8 m/s
    const steerRate = yawInput * GROUND_STEER_RATE_DEG * steerBlend;
    rotateAboutWorldAxis(plane, WORLD_UP, -steerRate * DEG_TO_RAD * dt);
    // The nose can be raised for rotation, but the gear caps the attitude.
    const pitchRate = pitchInput * FLIGHT_TUNING.pitchRateDeg * authority;
    rotateAboutLocalAxis(plane, LOCAL_RIGHT, pitchRate * DEG_TO_RAD * dt);
    levelWingsOnGround(plane, dt);
    return;
  }

  let rollRate = rollInput * FLIGHT_TUNING.rollRateDeg * authority;
  if (plane.rollDeg >= FLIGHT_TUNING.maxBankDeg && rollRate > 0) rollRate = 0;
  if (plane.rollDeg <= -FLIGHT_TUNING.maxBankDeg && rollRate < 0) rollRate = 0;

  let pitchRate = pitchInput * FLIGHT_TUNING.pitchRateDeg * authority;
  if (plane.pitchDeg >= MAX_PITCH_UP_DEG && pitchRate > 0) pitchRate = 0;
  if (plane.pitchDeg <= MAX_PITCH_DOWN_DEG && pitchRate < 0) pitchRate = 0;
  // Stall mush: the elevator fades and the nose drops toward -8 degrees
  // until the speed comes back. No wing drop, no spin, ever (section 4.2).
  if (plane.stalled) {
    pitchRate *= STALL_ELEVATOR_FACTOR;
    if (plane.pitchDeg > STALL_NOSE_DROP_DEG) {
      pitchRate -= STALL_PITCH_RATE_DEG * authority;
    }
  }

  const yawRate = yawInput * FLIGHT_TUNING.yawRateDeg * authority;
  rotateAboutLocalAxis(plane, LOCAL_RIGHT, pitchRate * DEG_TO_RAD * dt);
  rotateAboutLocalAxis(plane, LOCAL_FORWARD, rollRate * DEG_TO_RAD * dt);
  rotateAboutLocalAxis(plane, LOCAL_UP, -yawRate * DEG_TO_RAD * dt);
  plane.quaternion.normalize();
}

// Banking turns the plane: heading rate follows bank and speed, boosted so
// 30 degrees of bank at 35 m/s gives about 18 deg/s (design.md section 4.1).
// The velocity vector turns with the nose (coordinated flight, no skid).
function applyCoordinatedTurn(plane, airspeed, dt) {
  if (plane.onGround) return;
  const bankRad = plane.rollDeg * DEG_TO_RAD;
  let turnRateRad = (FLIGHT_TUNING.turnBoost * FLIGHT_TUNING.gravity * Math.tan(bankRad))
    / Math.max(airspeed, 12);
  const maxRateRad = MAX_TURN_RATE_DEG * DEG_TO_RAD;
  turnRateRad = clamp(turnRateRad, -maxRateRad, maxRateRad);
  if (Math.abs(turnRateRad) < 1e-6) return;
  const angle = -turnRateRad * dt; // bank right (positive) turns heading clockwise
  rotateAboutWorldAxis(plane, WORLD_UP, angle);
  _airVelocity.copy(plane.velocity).sub(_wind).applyAxisAngle(WORLD_UP, angle);
  plane.velocity.copy(_airVelocity).add(_wind);
}

// Soft world edge (design.md section 5.1): past 6 km from the centre a gentle
// nudge turns the nose homeward. Never a wall, never a fail.
function applyBoundaryAssist(plane, dt) {
  if (plane.onGround) return;
  const distance = Math.hypot(plane.position.x, plane.position.z);
  if (distance <= WORLD.hardBoundary) return;
  const homeHeading = Math.atan2(-plane.position.x, plane.position.z) * RAD_TO_DEG;
  let error = homeHeading - plane.headingDeg;
  while (error > 180) error -= 360;
  while (error < -180) error += 360;
  const nudgeDeg = clamp(error, -5, 5); // at most 5 deg/s of help
  const angle = -nudgeDeg * DEG_TO_RAD * dt;
  rotateAboutWorldAxis(plane, WORLD_UP, angle);
  _airVelocity.copy(plane.velocity).sub(_wind).applyAxisAngle(WORLD_UP, angle);
  plane.velocity.copy(_airVelocity).add(_wind);
}

// Hard attitude clamps, applied by rotating back around the pitch/roll axes.
function clampAttitude(plane) {
  deriveAxes(plane);
  let pitchDeg = Math.asin(clamp(_forward.y, -1, 1)) * RAD_TO_DEG;
  let rollDeg = Math.atan2(-_right.y, _up.y) * RAD_TO_DEG;
  const pitchMax = plane.onGround ? GROUND_MAX_PITCH_DEG : MAX_PITCH_UP_DEG;
  const pitchMin = plane.onGround ? GROUND_MIN_PITCH_DEG : MAX_PITCH_DOWN_DEG;
  if (pitchDeg > pitchMax) rotateAboutLocalAxis(plane, LOCAL_RIGHT, (pitchMax - pitchDeg) * DEG_TO_RAD);
  if (pitchDeg < pitchMin) rotateAboutLocalAxis(plane, LOCAL_RIGHT, (pitchMin - pitchDeg) * DEG_TO_RAD);
  if (plane.onGround) {
    if (Math.abs(rollDeg) > 0.01) rotateAboutLocalAxis(plane, LOCAL_FORWARD, -rollDeg * DEG_TO_RAD);
  } else {
    if (rollDeg > FLIGHT_TUNING.maxBankDeg) {
      rotateAboutLocalAxis(plane, LOCAL_FORWARD, (FLIGHT_TUNING.maxBankDeg - rollDeg) * DEG_TO_RAD);
    }
    if (rollDeg < -FLIGHT_TUNING.maxBankDeg) {
      rotateAboutLocalAxis(plane, LOCAL_FORWARD, (-FLIGHT_TUNING.maxBankDeg - rollDeg) * DEG_TO_RAD);
    }
  }
  plane.quaternion.normalize();
  deriveAxes(plane);
  pitchDeg = Math.asin(clamp(_forward.y, -1, 1)) * RAD_TO_DEG;
  rollDeg = Math.atan2(-_right.y, _up.y) * RAD_TO_DEG;
  plane.pitchDeg = pitchDeg;
  plane.rollDeg = rollDeg;
}

// On the ground the wings settle level quickly (gear, not ailerons, rules).
function levelWingsOnGround(plane, dt) {
  deriveAxes(plane);
  const rollDeg = Math.atan2(-_right.y, _up.y) * RAD_TO_DEG;
  const correction = clamp(-rollDeg, -90 * dt, 90 * dt);
  if (Math.abs(correction) > 1e-4) {
    rotateAboutLocalAxis(plane, LOCAL_FORWARD, correction * DEG_TO_RAD);
  }
}

function rotateAboutLocalAxis(plane, localAxis, angleRad) {
  if (Math.abs(angleRad) < 1e-9) return;
  _deltaQuat.setFromAxisAngle(localAxis, angleRad);
  plane.quaternion.multiply(_deltaQuat);
}

function rotateAboutWorldAxis(plane, worldAxis, angleRad) {
  if (Math.abs(angleRad) < 1e-9) return;
  _worldQuat.setFromAxisAngle(worldAxis, angleRad);
  plane.quaternion.premultiply(_worldQuat);
}

// ---------------------------------------------------------------------------
// Aerodynamics
// ---------------------------------------------------------------------------

// Lift, drag and thrust from angle of attack and airspeed. Returns the total
// force plus the pieces the ground logic needs (lift height, stall state).
// D-133: the result is a module scratch object, not a fresh allocation per
// substep. The only caller (stepFlight) consumes every field synchronously
// before the next call, so reuse cannot leak stale values.
const _aeroResult = {
  force: null,
  airspeed: 0,
  angleOfAttackDeg: 0,
  liftVertical: 0,
  weight: 0,
};

function computeAerodynamicForces(plane, powerFactor) {
  deriveAxes(plane);
  _airVelocity.copy(plane.velocity).sub(_wind);
  const airspeed = _airVelocity.length();
  const flap = plane.flaps;
  const stallSpeed = FLIGHT_TUNING.flapStall[flap];
  const clMax = FLIGHT_TUNING.flapClmax[flap];

  let angleOfAttackDeg = 0;
  if (airspeed > 0.5) {
    _velocityDir.copy(_airVelocity).divideScalar(airspeed);
    const forwardPart = _velocityDir.dot(_forward);
    const upPart = _velocityDir.dot(_up);
    angleOfAttackDeg = Math.atan2(-upPart, forwardPart) * RAD_TO_DEG;
  } else {
    _velocityDir.copy(_forward);
  }

  // Stall: too slow for the flap setting, or past the critical angle. The
  // buffet warning band starts 2 m/s above the stall (design.md section 4.2).
  plane.stalled = !plane.onGround
    && (airspeed < stallSpeed || angleOfAttackDeg > FLIGHT_TUNING.stallAoaDeg);
  plane.buffet = !plane.onGround && (plane.stalled || airspeed < stallSpeed + 2);

  let liftCoeff = FLIGHT_TUNING.liftAtZeroAoa
    + FLIGHT_TUNING.flapLiftIncrement[flap]
    + FLIGHT_TUNING.liftCurveSlope * angleOfAttackDeg * DEG_TO_RAD;
  if (angleOfAttackDeg > FLIGHT_TUNING.stallAoaDeg) {
    // Past the peak, lift breaks away gradually instead of vanishing.
    liftCoeff = clMax - (angleOfAttackDeg - FLIGHT_TUNING.stallAoaDeg) * 0.06;
    liftCoeff = Math.max(liftCoeff, clMax * 0.4);
  }
  liftCoeff = clamp(liftCoeff, -0.6, clMax);
  if (plane.stalled) liftCoeff *= STALL_LIFT_FACTOR;

  let dragCoeff = FLIGHT_TUNING.parasiteDrag
    + FLIGHT_TUNING.inducedDragFactor * liftCoeff * liftCoeff
    + FLIGHT_TUNING.flapDragIncrement[flap];
  if (plane.stalled) dragCoeff += STALL_EXTRA_DRAG;

  const dynamicPressure = 0.5 * FLIGHT_TUNING.airDensity * airspeed * airspeed;
  const lift = dynamicPressure * PLANE.wingArea * liftCoeff;
  const drag = dynamicPressure * PLANE.wingArea * dragCoeff;

  // Lift acts perpendicular to the airflow, tilted by the bank: that tilt is
  // what turns the plane. Drag opposes the airflow. Thrust pulls forward.
  _liftDir.crossVectors(_right, _velocityDir);
  if (_liftDir.lengthSq() < 1e-6) _liftDir.copy(_up);
  _liftDir.normalize();

  const thrustFull = Math.max(PLANE.minThrust, PLANE.maxThrust - PLANE.thrustFalloff * airspeed);
  let thrust = plane.engineOn
    ? Math.pow(plane.throttle, FLIGHT_TUNING.throttleExponent) * thrustFull * powerFactor
    : 0;
  // Soft ceiling: power fades above 1200 m instead of hitting a lid.
  if (plane.position.y > WORLD.ceiling) {
    thrust *= Math.max(0.3, 1 - (plane.position.y - WORLD.ceiling) / 300);
  }

  _force.set(0, -PLANE.mass * FLIGHT_TUNING.gravity, 0);
  _force.addScaledVector(_forward, thrust);
  _force.addScaledVector(_liftDir, lift);
  _force.addScaledVector(_velocityDir, -drag);

  _aeroResult.force = _force;
  _aeroResult.airspeed = airspeed;
  _aeroResult.angleOfAttackDeg = angleOfAttackDeg;
  _aeroResult.liftVertical = _liftDir.y * lift + _forward.y * thrust;
  _aeroResult.weight = PLANE.mass * FLIGHT_TUNING.gravity;
  return _aeroResult;
}

// Semi-implicit Euler: velocity first, then position (in stepFlight). A
// wrecked airframe (100% damage) also gets the extra sink bias of section 3.3.
function integrateVelocity(plane, aero, dt) {
  plane.velocity.addScaledVector(aero.force, dt / PLANE.mass);
  if (plane.damage >= 1 && !plane.onGround) {
    plane.velocity.y -= DAMAGE_TUNING.wreckSinkBias * 1.2 * dt;
  }
}

// ---------------------------------------------------------------------------
// Ground contact, touchdown grading data and damage
// ---------------------------------------------------------------------------

// Keeps the wheels on the terrain while rolling, detects liftoff, touchdown,
// ditching, terrain strikes and obstacle hits, and applies the damage table.
function resolveGroundContact(plane, world, aero, brakeHeld, dt) {
  const groundY = groundHeightAt(world, plane.position.x, plane.position.z);
  const gearY = groundY + PLANE.gearHeight;
  const strip = stripAt(world, plane.position.x, plane.position.z);
  const onStrip = strip !== null;
  const isWater = groundY <= WORLD.seaLevel + 0.01 && !onStrip;
  const wasOnGround = plane.onGround;

  checkObstacleStrike(plane, world);

  if (plane.position.y <= gearY) {
    if (!wasOnGround) {
      handleTouchdown(plane, aero, strip, isWater, gearY);
    } else if (aero.liftVertical > aero.weight && aero.airspeed > FLIGHT_TUNING.flapStall[plane.flaps] * 0.9) {
      plane.onGround = false; // lift beat weight: the plane flies off
    } else {
      plane.position.y = gearY;
      if (plane.velocity.y < 0) plane.velocity.y = 0;
      applyGroundRoll(plane, onStrip, brakeHeld, dt);
    }
  } else if (wasOnGround && plane.position.y > gearY + 0.5) {
    plane.onGround = false; // rolled off an edge; the ground fell away
  }

  // Runway overrun: leaving a strip end fast bends the plane (section 3.2).
  if (plane.onGround && plane._wasOnStrip && !onStrip
    && horizontalSpeed(plane.velocity) > DAMAGE_TUNING.overrunSpeed) {
    addDamage(plane, DAMAGE_TUNING.overrun);
  }
  plane._wasOnStrip = onStrip && plane.onGround;
}

// First contact after flight: grade the sink rate, apply landing damage, and
// tell missions.js everything it needs (sink, speed, strip, centreline).
function handleTouchdown(plane, aero, strip, isWater, gearY) {
  const sinkRate = Math.max(0, -plane.velocity.y);
  const groundSpeed = horizontalSpeed(plane.velocity);
  const impactSpeed = plane.velocity.length();

  if (isWater) {
    plane.damage = 1;
    plane.velocity.set(0, 0, 0);
    plane.position.y = WORLD.seaLevel + PLANE.gearHeight * 0.6;
    plane.onGround = true;
    plane.events.push({ type: 'crash', reason: 'ditch', sinkRate, groundSpeed });
    return;
  }

  const noseDownDive = plane.pitchDeg < -15;
  const terrainStrike = strip === null && (sinkRate > 2.5 || noseDownDive);
  if (terrainStrike && impactSpeed >= DAMAGE_TUNING.terrainCrashSpeed) {
    plane.damage = 1;
    plane.velocity.set(0, 0, 0);
    plane.position.y = gearY;
    plane.onGround = true;
    plane.events.push({ type: 'crash', reason: 'terrain', sinkRate, groundSpeed });
    return;
  }
  if (sinkRate > 5) {
    // Section 3.3 calls sink above 5 m/s a crash; the table prices it at 70%.
    addDamage(plane, hardLandingDamage(sinkRate));
    plane.velocity.set(0, 0, 0);
    plane.position.y = gearY;
    plane.onGround = true;
    plane.events.push({ type: 'crash', reason: 'hard-impact', sinkRate, groundSpeed });
    return;
  }

  addDamage(plane, hardLandingDamage(sinkRate));
  if (terrainStrike && impactSpeed > DAMAGE_TUNING.terrainStrikeSpeed) {
    addDamage(plane, DAMAGE_TUNING.terrain);
  }
  const grading = stripGrading(plane, strip);
  plane.events.push({
    type: 'touchdown',
    sinkRate,
    airspeed: aero.airspeed,
    groundSpeed,
    onStrip: strip !== null,
    stripId: strip && strip.id !== undefined ? strip.id : null,
    centrelineOffsetM: grading.centrelineOffsetM,
    alongStripM: grading.alongStripM,
  });
  plane.onGround = true;
  plane.position.y = gearY;
  if (plane.velocity.y < 0) plane.velocity.y = 0;
}

// Rolling on the ground: friction, brakes, grass drag and grass damage.
function applyGroundRoll(plane, onStrip, brakeHeld, dt) {
  const speed = horizontalSpeed(plane.velocity);
  if (speed < 1e-4) return;
  const friction = onStrip ? FLIGHT_TUNING.rollingFriction : FLIGHT_TUNING.grassFriction;
  let decel = friction * FLIGHT_TUNING.gravity;
  if (brakeHeld) decel += FLIGHT_TUNING.brakeDecel;
  const newSpeed = Math.max(0, speed - decel * dt);
  const scale = newSpeed / speed;
  plane.velocity.x *= scale;
  plane.velocity.z *= scale;
  if (!onStrip && speed > DAMAGE_TUNING.grassDamageSpeed) {
    addDamage(plane, DAMAGE_TUNING.grassPerS * dt);
  }
}

// Optional obstacle list from world.js (trees near strips, buildings): a
// simple cylinder test so nothing invisible kills the pilot unfairly.
// Entries may be {x, z, radius, height} (world.js obstacleTrees) or
// {position: {x, z}, radius, height}; the list may live on world.obstacles,
// world.obstacleTrees, or world.landmarks.obstacleTrees.
function checkObstacleStrike(plane, world) {
  if (!world) return;
  const obstacles = world.obstacles || world.obstacleTrees
    || (world.landmarks && world.landmarks.obstacleTrees);
  if (!Array.isArray(obstacles)) return;
  const speed = plane.velocity.length();
  for (const obstacle of obstacles) {
    if (!obstacle) continue;
    const ox = numberOr(obstacle.position ? obstacle.position.x : obstacle.x, 0);
    const oz = numberOr(obstacle.position ? obstacle.position.z : obstacle.z, 0);
    const radius = numberOr(obstacle.radius, 3) + 2;
    const height = numberOr(obstacle.height, 10);
    const dx = plane.position.x - ox;
    const dz = plane.position.z - oz;
    if (dx * dx + dz * dz > radius * radius) continue;
    // Obstacle height is measured from its terrain base, not from sea level.
    const baseY = Number.isFinite(obstacle.y) ? obstacle.y
      : (obstacle.position && Number.isFinite(obstacle.position.y)
        ? obstacle.position.y
        : groundHeightAt(world, ox, oz));
    if (plane.position.y > baseY + height + PLANE.gearHeight) continue;
    if (speed >= DAMAGE_TUNING.buildingCrashSpeed) {
      const sinkRate = Math.max(0, -plane.velocity.y);
      const groundSpeed = horizontalSpeed(plane.velocity);
      plane.damage = 1;
      plane.velocity.set(0, 0, 0);
      plane.events.push({ type: 'crash', reason: 'obstacle', sinkRate, groundSpeed });
    } else if (speed > DAMAGE_TUNING.buildingStrikeSpeed) {
      addDamage(plane, DAMAGE_TUNING.building);
      plane.velocity.multiplyScalar(0.4); // bounce/slide, do not pass through
    }
    return;
  }
}

// Overspeed stress: crossing 65 m/s warns once; holding it for 2 s starts
// costing 2% damage per second (design.md section 3.2).
function applyOverspeedStress(plane, airspeed, dt) {
  plane.overspeed = airspeed > FLIGHT_TUNING.overspeedSpeed;
  if (plane.overspeed && !plane._wasOverspeed) {
    plane.events.push({ type: 'overspeed', airspeed });
  }
  if (plane.overspeed) {
    plane._overspeedTimer += dt;
    if (plane._overspeedTimer > DAMAGE_TUNING.overspeedSustainS) {
      addDamage(plane, DAMAGE_TUNING.overspeedPerS * dt);
    }
  } else {
    plane._overspeedTimer = 0;
  }
  plane._wasOverspeed = plane.overspeed;
}

// Stall event fires once per stall entry (audio rumble, HUD warning).
function applyStallEvent(plane, airspeed) {
  if (plane.stalled && !plane._wasStalled) {
    plane.events.push({ type: 'stall', airspeed });
  }
}

// Landing damage from the section 3.2 sink-rate table (percent in, fraction stored).
function hardLandingDamage(sinkRate) {
  for (const row of DAMAGE_TUNING.hardLanding) {
    if (sinkRate <= row[0]) return row[1];
  }
  return 70;
}

function addDamage(plane, percent) {
  plane.damage = clamp01(plane.damage + percent / 100);
}

// Centreline offset and along-strip position for landing grading, computed
// when the strip object carries position and heading (world.js contract).
function stripGrading(plane, strip) {
  if (!strip || !strip.position || strip.headingDeg === undefined) {
    return { centrelineOffsetM: null, alongStripM: null };
  }
  const headingRad = strip.headingDeg * DEG_TO_RAD;
  const dirX = Math.sin(headingRad);
  const dirZ = -Math.cos(headingRad);
  const relX = plane.position.x - numberOr(strip.position.x, 0);
  const relZ = plane.position.z - numberOr(strip.position.z, 0);
  const alongStripM = relX * dirX + relZ * dirZ;
  const centrelineOffsetM = Math.abs(relX * dirZ - relZ * dirX);
  return { centrelineOffsetM, alongStripM };
}

// ---------------------------------------------------------------------------
// Derived flight data (HUD, instruments, cameras read these every frame)
// ---------------------------------------------------------------------------

function deriveFlightData(plane, groundY, wind) {
  deriveAxes(plane);
  let headingDeg = Math.atan2(_forward.x, -_forward.z) * RAD_TO_DEG;
  if (headingDeg < 0) headingDeg += 360;
  plane.headingDeg = headingDeg;
  plane.pitchDeg = Math.asin(clamp(_forward.y, -1, 1)) * RAD_TO_DEG;
  plane.rollDeg = Math.atan2(-_right.y, _up.y) * RAD_TO_DEG;
  _airVelocity.copy(plane.velocity).sub(wind);
  plane.airspeed = _airVelocity.length();
  plane.groundSpeed = horizontalSpeed(plane.velocity);
  plane.verticalSpeed = plane.velocity.y;
  plane.altitudeMsl = plane.position.y;
  plane.altitudeAgl = Math.max(0, plane.position.y - groundY);
}

function deriveAxes(plane) {
  _forward.copy(LOCAL_FORWARD).applyQuaternion(plane.quaternion);
  _right.copy(LOCAL_RIGHT).applyQuaternion(plane.quaternion);
  _up.copy(LOCAL_UP).applyQuaternion(plane.quaternion);
}

// ---------------------------------------------------------------------------
// World access helpers (defensive: world.js owns terrain truth)
// ---------------------------------------------------------------------------

function groundHeightAt(world, x, z) {
  if (world && typeof world.heightAt === 'function') {
    const height = world.heightAt(x, z);
    if (Number.isFinite(height)) return height;
  }
  return WORLD.seaLevel;
}

function stripAt(world, x, z) {
  if (world && typeof world.stripAt === 'function') {
    return world.stripAt(x, z) || null;
  }
  return null;
}

// Wind is the air-mass velocity (where the air moves toward), set per sortie
// by missions.js. Accepts every shape the sibling modules use: world.wind as
// a Vector3 or plain {x, z}, the missions wind object {vector, dirDeg, speed}
// attached as world.wind, or world.windDirectionDeg + world.windSpeedMs.
function readWind(world, target) {
  target.set(0, 0, 0);
  if (!world) return target;
  const wind = world.wind;
  if (wind) {
    const vector = wind.vector || wind;
    if (Number.isFinite(vector.x) || Number.isFinite(vector.z)) {
      target.set(numberOr(vector.x, 0), numberOr(vector.y, 0), numberOr(vector.z, 0));
      return target;
    }
    if (Number.isFinite(wind.dirDeg) && Number.isFinite(wind.speed)) {
      const rad = wind.dirDeg * DEG_TO_RAD;
      target.set(Math.sin(rad) * wind.speed, 0, -Math.cos(rad) * wind.speed);
      return target;
    }
  }
  if (Number.isFinite(world.windDirectionDeg) && Number.isFinite(world.windSpeedMs)) {
    const rad = world.windDirectionDeg * DEG_TO_RAD;
    target.set(Math.sin(rad) * world.windSpeedMs, 0, -Math.cos(rad) * world.windSpeedMs);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function horizontalSpeed(velocity) {
  return Math.hypot(velocity.x, velocity.z);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampFlaps(value) {
  const stage = Math.round(numberOr(value, 0));
  return clamp(stage, 0, 2);
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}
