// missions.js — AURORA POST mission definitions, scoring, objective
// detection, fuel/damage economy and campaign progression (A10).
//
// Owns sim.mission (MissionState). Reads sim.plane (flight.js) and the
// world object (world.js: heightAt / stripAt / rings / dropZones /
// setRingState). Pushes score and feedback events into sim.events for
// main.js to route to audio + HUD. All scoring numbers come from
// design.md section 2/3 and Appendix A. Units: metres, seconds, m/s.
// Plane fuel and damage are 0..1 fractions (interfaces.md).

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Scoring and economy constants (design.md Appendix A)
// ---------------------------------------------------------------------------

const RING_POINTS = 250;
const RING_CENTRE_BONUS = 150;
const DROP_BASE_POINTS = 500;
const DROP_BULLSEYE_BONUS = 300;
const DROP_NEAR_MISS_RADIUS = 60;
const DROP_NEAR_MISS_POINTS = 150;
const DELIVERY_UNLOAD_POINTS = 1200;
const DELIVERY_RETURN_POINTS = 800;
const DELIVERY_DIVERT_POINTS = 400;
const LANDING_BONUS_MAX = 400;
const HOME_STRIP_BONUS = 150;
const FUEL_BONUS_PER_PERCENT = 2;
const DAMAGE_PENALTY_PER_PERCENT = 15;
const TIME_BONUS_PER_SECOND = 5;
const TIME_BONUS_CAP = 600;
const GO_AROUND_PENALTY = 100;
const MAX_GO_AROUND_PENALTIES = 2;
const ENGINE_OUT_PENALTY = 300;
const MEDAL_FRACTIONS = { bronze: 0.4, silver: 0.65, gold: 0.85 };

// Fuel burn is owned by flight.js (burnFuel: 0.04 + 0.26*throttle units/s
// on a 100-unit tank, via config FUEL_TUNING). missions.js must NOT burn
// fuel here — an identical formula in stepFuelAndServicing double-burned
// the tank (defect D-01). This module only watches fuel for warnings /
// engine-out and runs the refuel + repair timers.
const FUEL_LOW_FRACTION = 0.25;
const FUEL_CRITICAL_FRACTION = 0.1;
const REFUEL_SECONDS = 4;
const REPAIR_SECONDS = 6;

const UNLOAD_SECONDS = 3;
const FULL_STOP_SPEED = 0.5; // m/s ground speed that counts as stopped
const FULL_STOP_HOLD_SECONDS = 1;
const PARKING_BOX_HALF_SIZE = 5; // 10 x 10 m box
const PARKING_BOX_SLACK = 2;

const PARCEL_GRAVITY = 9.81;
const PARCEL_CHUTE_DELAY_SECONDS = 1;
const PARCEL_CHUTE_TERMINAL_SPEED = 6; // m/s descent under canopy

const GRAVITY = 9.81;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampValue(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toVector3(value, fallbackY) {
  if (!value) return new THREE.Vector3(0, fallbackY || 0, 0);
  if (value.isVector3) return value.clone();
  return new THREE.Vector3(value.x || 0, value.y !== undefined ? value.y : (fallbackY || 0), value.z || 0);
}

function headingToForwardVector(headingDeg) {
  // Heading 0 = north (-Z), degrees clockwise (interfaces.md).
  const radians = (headingDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(radians), 0, -Math.cos(radians));
}

function headingToRightVector(headingDeg) {
  const radians = (headingDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(radians), 0, Math.sin(radians));
}

function pushEvent(sim, event) {
  if (!Array.isArray(sim.events)) sim.events = [];
  sim.events.push(event);
}

function addScore(sim, mission, label, points) {
  const rounded = Math.round(points);
  mission.score += rounded;
  mission.breakdown.push({ label: label, points: rounded });
  sim.score = mission.score;
  pushEvent(sim, { type: 'score', label: label, points: rounded, total: mission.score });
  return rounded;
}

function setObjective(sim, mission, objectiveText) {
  if (mission.objective === objectiveText) return;
  mission.objective = objectiveText;
  pushEvent(sim, { type: 'objectiveChanged', objective: objectiveText });
}

// ---------------------------------------------------------------------------
// Strip resolution (world.js owns strips; design.md section 5.3 fallback)
// ---------------------------------------------------------------------------

// Strip ids are the short ids from config.js STRIPS / world.js
// (aurora, brine, gull, lantern, twin) — D-141: missions previously
// used long ids (aurora-field, gull-strip, ...) that never matched the
// world strips, so delivery/precision targets silently fell back to
// the wrong island.
const FALLBACK_STRIPS = [
  { id: 'aurora', name: 'Aurora Field', position: new THREE.Vector3(0, 0, 0), headingDeg: 90, length: 350, width: 18 },
  { id: 'brine', name: 'Brine Strip', position: new THREE.Vector3(2800, 0, -1600), headingDeg: 45, length: 300, width: 18 },
  { id: 'gull', name: 'Gull Strip', position: new THREE.Vector3(-2400, 0, -2200), headingDeg: 135, length: 300, width: 18 },
  { id: 'lantern', name: 'Lantern Strip', position: new THREE.Vector3(1800, 0, 2600), headingDeg: 0, length: 300, width: 18 },
  { id: 'twin', name: 'Twin Strip', position: new THREE.Vector3(3800, 0, 2200), headingDeg: 90, length: 220, width: 18 },
];

// Legacy long ids (pre-D-141) mapped to the canonical short ids, so any
// stale caller or saved reference still resolves to the right strip.
const STRIP_ID_ALIASES = {
  'aurora-field': 'aurora',
  'brine-strip': 'brine',
  'gull-strip': 'gull',
  'lantern-strip': 'lantern',
  'twin-strip': 'twin',
};

function canonicalStripId(stripId) {
  return STRIP_ID_ALIASES[stripId] || stripId;
}

function normaliseStrip(rawStrip) {
  if (!rawStrip) return null;
  const position = toVector3(rawStrip.position || rawStrip.centre || rawStrip.center, 0);
  return {
    id: rawStrip.id || rawStrip.name || 'strip',
    name: rawStrip.name || rawStrip.id || 'Strip',
    position: position,
    headingDeg: rawStrip.headingDeg !== undefined ? rawStrip.headingDeg : (rawStrip.heading || 0),
    length: rawStrip.length || 300,
    width: rawStrip.width || 18,
    parkingBox: rawStrip.parkingBox || null,
    raw: rawStrip,
  };
}

function resolveStrips(world) {
  let rawList = null;
  if (world) {
    if (Array.isArray(world.strips)) rawList = world.strips;
    else if (Array.isArray(world.STRIPS)) rawList = world.STRIPS;
    else if (typeof world.getStrips === 'function') rawList = world.getStrips();
  }
  const source = rawList && rawList.length ? rawList : FALLBACK_STRIPS;
  return source.map(normaliseStrip).filter(Boolean);
}

function findStripById(strips, stripId) {
  const wanted = canonicalStripId(stripId);
  for (const strip of strips) {
    if (canonicalStripId(strip.id) === wanted) return strip;
  }
  return null;
}

// D-133: strip-frame math runs per substep (stripAtPosition fallback,
// touchdown grading), so it is pure arithmetic into a scratch result —
// forward = (sin, 0, -cos), right = (cos, 0, sin) per the helpers above,
// dotted with the centre-relative delta. Both callers read the fields
// immediately, so the shared object is safe.
const _stripFrame = { along: 0, across: 0 };

function stripFrameOffset(strip, worldPosition) {
  // Offset of a world position in strip coordinates: along (from centre,
  // positive in heading direction) and across (positive to the right).
  const radians = (strip.headingDeg * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const dx = worldPosition.x - strip.position.x;
  const dz = worldPosition.z - strip.position.z;
  _stripFrame.along = dx * sin - dz * cos;
  _stripFrame.across = dx * cos + dz * sin;
  return _stripFrame;
}

function stripAtPosition(world, strips, worldPosition) {
  if (world && typeof world.stripAt === 'function') {
    const found = world.stripAt(worldPosition.x, worldPosition.z);
    if (found) {
      const normalised = normaliseStrip(found);
      // Prefer the resolved strip with the same id so parking data matches.
      const match = findStripById(strips, normalised.id);
      return match || normalised;
    }
    return null;
  }
  for (const strip of strips) {
    const frame = stripFrameOffset(strip, worldPosition);
    if (Math.abs(frame.along) <= strip.length / 2 && Math.abs(frame.across) <= strip.width / 2 + 2) {
      return strip;
    }
  }
  return null;
}

function groundHeightAt(world, x, z) {
  if (!world) return 0;
  if (typeof world.heightAt === 'function') return world.heightAt(x, z);
  if (typeof world.getHeightAt === 'function') return world.getHeightAt(x, z);
  if (typeof world.terrainHeight === 'function') return world.terrainHeight(x, z);
  return 0;
}

function seaLevelOf(world) {
  if (!world) return 0;
  if (typeof world.seaLevel === 'number') return world.seaLevel;
  if (typeof world.SEA_LEVEL === 'number') return world.SEA_LEVEL;
  return 0;
}

// D-133: returns a module scratch vector — both callers (isInsideParkingBox
// below, updateNextTarget) consume the components immediately and never
// retain the reference.
const _parkingCentre = new THREE.Vector3();

function parkingBoxCentre(strip) {
  if (strip.parkingBox) {
    const centre = strip.parkingBox.centre || strip.parkingBox.center || strip.parkingBox.position;
    if (centre) {
      _parkingCentre.set(
        centre.x || 0,
        centre.y !== undefined ? centre.y : strip.position.y,
        centre.z || 0,
      );
      return _parkingCentre;
    }
  }
  // Apron end of the strip, 15 m in from the far threshold.
  const radians = (strip.headingDeg * Math.PI) / 180;
  const offset = strip.length / 2 - 15;
  _parkingCentre.set(
    strip.position.x + Math.sin(radians) * offset,
    strip.position.y,
    strip.position.z - Math.cos(radians) * offset,
  );
  return _parkingCentre;
}

function isInsideParkingBox(strip, worldPosition) {
  const centre = parkingBoxCentre(strip);
  const radians = (strip.headingDeg * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const dx = worldPosition.x - centre.x;
  const dz = worldPosition.z - centre.z;
  const along = Math.abs(dx * sin - dz * cos);
  const across = Math.abs(dx * cos + dz * sin);
  const limit = PARKING_BOX_HALF_SIZE + PARKING_BOX_SLACK;
  return along <= limit && across <= limit;
}

function nearestStrip(strips, worldPosition) {
  let best = null;
  let bestDistance = Infinity;
  for (const strip of strips) {
    const distance = strip.position.distanceTo(worldPosition);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = strip;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Mission data — 12 sorties, 4 types x 3 tiers (design.md section 6.1)
// ---------------------------------------------------------------------------

const RING_ROUTES = {
  1: [
    { x: 1200, z: -600, altitude: 120 },
    { x: 2300, z: -1300, altitude: 110 },
    { x: 2900, z: -1900, altitude: 130 },
    { x: 2500, z: -200, altitude: 120 },
    { x: 1900, z: 1800, altitude: 110 },
    { x: 1500, z: 2900, altitude: 130 },
    { x: 500, z: 1500, altitude: 100 },
    { x: -900, z: 0, altitude: 90 },
  ],
  2: [
    { x: -1200, z: -1000, altitude: 120 },
    { x: -2300, z: -2000, altitude: 130 },
    { x: -1800, z: -400, altitude: 110 },
    { x: -1000, z: 1500, altitude: 120 },
    { x: -800, z: 3300, altitude: 190 },
    { x: 400, z: 2800, altitude: 120 },
    { x: 1700, z: 2700, altitude: 110 },
    { x: 2200, z: 800, altitude: 120 },
    { x: 800, z: -300, altitude: 100 },
    { x: -900, z: 0, altitude: 90 },
  ],
  3: [
    { x: 1400, z: -800, altitude: 110 },
    { x: 2800, z: -1700, altitude: 120 },
    { x: 3600, z: 600, altitude: 110 },
    { x: 3900, z: 2200, altitude: 120 },
    { x: 2400, z: 3000, altitude: 110 },
    { x: 600, z: 3400, altitude: 130 },
    { x: -800, z: 3600, altitude: 190 },
    { x: -2400, z: 2200, altitude: 110 },
    { x: -3200, z: 1800, altitude: 100 },
    { x: -2400, z: -2200, altitude: 130 },
    { x: -1500, z: -1200, altitude: 100 },
    { x: -900, z: 0, altitude: 90 },
  ],
};

const RING_RADIUS_BY_TIER = { 1: 14, 2: 12, 3: 10 }; // user order 2026-11-27: rings a bit bigger (was 12/10/8); visual hoop + pass detection share this radius
const DROP_ZONE_RADIUS_BY_TIER = { 1: 25, 2: 20, 3: 15 };

const DROP_ZONE_SPOTS = {
  brine: { name: 'Brine Cay', x: 2650, z: -1450 },
  lantern: { name: 'Lantern Isle', x: 1650, z: 2450 },
  widowsReef: { name: "Widow's Reef", x: -3050, z: 1650 },
  gull: { name: 'Gull Rock', x: -2250, z: -2050 },
  twins: { name: 'The Twins', x: 3750, z: 2050 },
};

const WIND_BY_TIER = {
  1: { speed: 1, gustAmp: 0 },
  2: { speed: 4, gustAmp: 2 },
  3: { speed: 7.5, gustAmp: 4 },
};

function computeMaxScore(definition) {
  const landingAndFuel = LANDING_BONUS_MAX + FUEL_BONUS_PER_PERCENT * 100 + HOME_STRIP_BONUS;
  if (definition.type === 'ring') {
    const ringCount = RING_ROUTES[definition.tier].length;
    return ringCount * (RING_POINTS + RING_CENTRE_BONUS) + TIME_BONUS_CAP + landingAndFuel;
  }
  if (definition.type === 'cargo') {
    // Cargo doubles the fuel bonus (design.md section 2.2).
    return definition.parcelCount * (DROP_BASE_POINTS + DROP_BULLSEYE_BONUS)
      + LANDING_BONUS_MAX + FUEL_BONUS_PER_PERCENT * 2 * 100 + HOME_STRIP_BONUS;
  }
  if (definition.type === 'delivery') {
    // Two landing bonuses: outbound and return (design.md section 2.3).
    return DELIVERY_UNLOAD_POINTS + DELIVERY_RETURN_POINTS + LANDING_BONUS_MAX * 2
      + TIME_BONUS_CAP + FUEL_BONUS_PER_PERCENT * 100 + HOME_STRIP_BONUS;
  }
  // Precision landing: the 1000-point touchdown grade is the score.
  const homeBonus = canonicalStripId(definition.targetStripId) === 'aurora' ? HOME_STRIP_BONUS : 0;
  return 1000 + FUEL_BONUS_PER_PERCENT * 100 + homeBonus;
}

const MISSION_DEFINITIONS = [
  {
    id: 'first-light', type: 'precision', tier: 1, title: 'First Light',
    briefing: 'You are already airborne on downwind for Aurora Field. Fly one calm circuit and grease it on: gentle sink, on the centreline, at approach speed.',
    targetStripId: 'aurora', airborneStart: true, approachOffsetDeg: 0,
  },
  {
    id: 'thread-the-dawn', type: 'ring', tier: 1, title: 'Thread the Dawn',
    briefing: 'Thread the glowing rings in order over Brine Cay and Lantern Isle, then land. Centred rings and a quick lap pay best.',
  },
  {
    id: 'parcels-for-brine-cay', type: 'cargo', tier: 1, title: 'Parcels for Brine Cay',
    briefing: 'Three parcels for three island drop zones. Low and slow puts them on the cross; high and fast scatters them. Then land anywhere.',
    parcelCount: 3, dropZoneKeys: ['brine', 'lantern', 'widowsReef'],
  },
  {
    id: 'mail-for-gull-rock', type: 'delivery', tier: 1, title: 'Mail for Gull Rock',
    briefing: 'Carry the mail to Gull Rock, stop in the parking box to unload, then fly home to Aurora Field. Mind the fuel gauge.',
    destinationStripId: 'gull',
  },
  {
    id: 'grease-it-on', type: 'precision', tier: 2, title: 'Grease It On',
    briefing: 'Airborne again, offset from the strip with a fresh crosswind. Crab into wind, stay on speed, and put it on the centreline.',
    targetStripId: 'aurora', airborneStart: true, approachOffsetDeg: 15,
  },
  {
    id: 'the-lantern-loop', type: 'ring', tier: 2, title: 'The Lantern Loop',
    briefing: 'Ten rings around Gull Rock, Signal Hill and Lantern Isle in a fresh breeze. Smaller rings, same dawn.',
  },
  {
    id: 'far-shore-post', type: 'cargo', tier: 2, title: 'Far Shore Post',
    briefing: 'Four parcels, four zones, a crosswind to allow for. Watch the drift and release early into wind.',
    parcelCount: 4, dropZoneKeys: ['brine', 'gull', 'lantern', 'widowsReef'],
  },
  {
    id: 'the-long-way-home', type: 'delivery', tier: 2, title: 'The Long Way Home',
    briefing: 'Mail for Lantern Isle and back, with wind on both legs. Cruise throttle gets you home with fuel to spare; full throttle may not.',
    destinationStripId: 'lantern',
  },
  {
    id: 'short-strip-long-day', type: 'precision', tier: 3, title: 'Short Strip, Long Day',
    briefing: 'Take off from Aurora Field and land on the short Twin Strip in a gusty crosswind. Full flap, on speed, no float.',
    targetStripId: 'twin', airborneStart: false, approachOffsetDeg: 0,
  },
  {
    id: 'squall-line', type: 'ring', tier: 3, title: 'Squall Line',
    briefing: 'Twelve tight rings around the whole archipelago in squally haze, on a short fuel load. Smooth flying beats fast flying.',
  },
  {
    id: 'widows-reef-run', type: 'cargo', tier: 3, title: "Widow's Reef Run",
    briefing: 'Five parcels into five small zones in gusty air. Every release is a judgement call on height, speed and drift.',
    parcelCount: 5, dropZoneKeys: ['widowsReef', 'gull', 'lantern', 'brine', 'twins'],
  },
  {
    id: 'aurora-round', type: 'delivery', tier: 3, title: 'Aurora Round',
    briefing: 'The finale: mail to the short Twin Strip and home again, gusty and hazy on 85% fuel. Fly the round like you mean it.',
    destinationStripId: 'twin',
  },
];

export const MISSIONS = MISSION_DEFINITIONS.map(function (definition) {
  return Object.assign({}, definition, { maxScore: computeMaxScore(definition) });
});

export function getMissionDef(missionId) {
  for (const definition of MISSIONS) {
    if (definition.id === missionId) return definition;
  }
  return null;
}

export function maxScore(missionOrId) {
  const definition = typeof missionOrId === 'string' ? getMissionDef(missionOrId) : missionOrId;
  if (!definition) return 0;
  if (typeof definition.maxScore === 'number') return definition.maxScore;
  return computeMaxScore(definition);
}

export function medalForScore(score, missionMaxScore) {
  if (!missionMaxScore || missionMaxScore <= 0) return null;
  const fraction = score / missionMaxScore;
  if (fraction >= MEDAL_FRACTIONS.gold) return 'Gold';
  if (fraction >= MEDAL_FRACTIONS.silver) return 'Silver';
  if (fraction >= MEDAL_FRACTIONS.bronze) return 'Bronze';
  return null;
}

// ---------------------------------------------------------------------------
// Campaign progression (design.md section 6: linear unlock, fail-forward)
// ---------------------------------------------------------------------------

function ensureCampaignFields(campaign) {
  if (!Array.isArray(campaign.completed)) campaign.completed = [];
  if (!campaign.bestScores || typeof campaign.bestScores !== 'object') campaign.bestScores = {};
  if (!campaign.medals || typeof campaign.medals !== 'object') campaign.medals = {};
  if (!campaign.fails || typeof campaign.fails !== 'object') campaign.fails = {};
  if (typeof campaign.totalScore !== 'number') campaign.totalScore = 0;
  return campaign;
}

export function isUnlocked(missionId, campaign) {
  if (missionId === 'free-flight') return true;
  const index = MISSIONS.findIndex(function (definition) { return definition.id === missionId; });
  if (index <= 0) return true;
  if (!campaign) return false;
  ensureCampaignFields(campaign);
  if (campaign.completed.indexOf(missionId) !== -1) return true;
  const previous = MISSIONS[index - 1];
  if (campaign.completed.indexOf(previous.id) !== -1) return true;
  // Fail-forward: two failed attempts at the previous sortie unlock this one.
  return (campaign.fails[previous.id] || 0) >= 2;
}

export function nextMission(campaign) {
  if (!campaign) return MISSIONS[0];
  ensureCampaignFields(campaign);
  for (const definition of MISSIONS) {
    if (campaign.completed.indexOf(definition.id) === -1 && isUnlocked(definition.id, campaign)) {
      return definition;
    }
  }
  for (const definition of MISSIONS) {
    if (campaign.completed.indexOf(definition.id) === -1) return definition;
  }
  return null;
}

export function recordResult(campaign, missionId, result) {
  if (!campaign || !result) return campaign;
  ensureCampaignFields(campaign);
  const definition = getMissionDef(missionId);
  if (!definition) return campaign;
  if (result.complete) {
    if (campaign.completed.indexOf(missionId) === -1) campaign.completed.push(missionId);
    campaign.fails[missionId] = 0;
  } else {
    campaign.fails[missionId] = (campaign.fails[missionId] || 0) + 1;
  }
  const previousBest = campaign.bestScores[missionId] || 0;
  if (result.score > previousBest) {
    campaign.bestScores[missionId] = result.score;
    campaign.medals[missionId] = medalForScore(result.score, definition.maxScore);
  }
  let total = 0;
  for (const key of Object.keys(campaign.bestScores)) total += campaign.bestScores[key];
  campaign.totalScore = total;
  return campaign;
}

// ---------------------------------------------------------------------------
// Landing grade (design.md section 2.4, reused for the common landing bonus)
// ---------------------------------------------------------------------------

function touchdownVerdictText(gradeTotal) {
  if (gradeTotal >= 900) return "Butter. The mail didn't even wake up.";
  if (gradeTotal >= 700) return 'Firm but fine.';
  if (gradeTotal >= 400) return 'Arrived. The plane noticed.';
  return 'That counts as a landing. Technically.';
}

function gradeTouchdown(plane, strip, sinkRate) {
  const sink = Math.abs(sinkRate);
  const sinkPoints = 400 * clampValue((3.5 - sink) / 2.5, 0, 1);
  let centrePoints = 0;
  let centreOffset = Infinity;
  let distancePastThreshold = 0;
  if (strip) {
    const frame = stripFrameOffset(strip, plane.position);
    centreOffset = Math.abs(frame.across);
    centrePoints = 300 * clampValue((8 - centreOffset) / 7, 0, 1);
    distancePastThreshold = frame.along + strip.length / 2;
  }
  const speed = plane.airspeed || 0;
  let speedFraction;
  if (speed <= 24) speedFraction = clampValue((speed - 16) / 8, 0, 1);
  else speedFraction = clampValue((38 - speed) / 14, 0, 1);
  const speedPoints = 300 * speedFraction;
  const zonePenalty = Math.min(300, 2 * Math.max(0, distancePastThreshold - 120));
  const total = Math.max(0, Math.round(sinkPoints + centrePoints + speedPoints - zonePenalty));
  return {
    total: total,
    sinkPoints: Math.round(sinkPoints),
    centrePoints: Math.round(centrePoints),
    speedPoints: Math.round(speedPoints),
    zonePenalty: Math.round(zonePenalty),
    sinkRate: sink,
    centreOffset: centreOffset,
    touchdownSpeed: speed,
    distancePastThreshold: distancePastThreshold,
    onStrip: Boolean(strip),
    stripId: strip ? strip.id : null,
    verdict: touchdownVerdictText(total),
  };
}

function landingBonusFromGrade(grade) {
  if (!grade) return 0;
  return Math.round((grade.total / 1000) * LANDING_BONUS_MAX);
}

// ---------------------------------------------------------------------------
// Mission setup
// ---------------------------------------------------------------------------

function buildRingsForMission(definition, world) {
  const route = RING_ROUTES[definition.tier];
  const radius = RING_RADIUS_BY_TIER[definition.tier];
  const rings = [];
  for (let i = 0; i < route.length; i++) {
    const point = route[i];
    const terrainHeight = groundHeightAt(world, point.x, point.z);
    const altitude = Math.max(point.altitude, terrainHeight + 25);
    const position = new THREE.Vector3(point.x, altitude, point.z);
    const nextPoint = route[Math.min(i + 1, route.length - 1)];
    const forward = new THREE.Vector3(nextPoint.x - point.x, 0, nextPoint.z - point.z);
    if (forward.lengthSq() < 0.001) forward.set(1, 0, 0);
    forward.normalize();
    const lookMatrix = new THREE.Matrix4().lookAt(
      position,
      position.clone().add(forward),
      new THREE.Vector3(0, 1, 0)
    );
    rings.push({
      position: position,
      radius: radius,
      quaternion: new THREE.Quaternion().setFromRotationMatrix(lookMatrix),
      forward: forward,
      state: i === 0 ? 'next' : 'todo',
      index: i,
    });
  }
  return rings;
}

function routeLengthMetres(rings, startPosition) {
  let total = 0;
  let previous = startPosition;
  for (const ring of rings) {
    total += previous.distanceTo(ring.position);
    previous = ring.position;
  }
  return total;
}

function buildDropZonesForMission(definition, world) {
  const radius = DROP_ZONE_RADIUS_BY_TIER[definition.tier];
  const zones = [];
  for (const key of definition.dropZoneKeys || []) {
    const spot = DROP_ZONE_SPOTS[key];
    if (!spot) continue;
    const terrainHeight = Math.max(groundHeightAt(world, spot.x, spot.z), seaLevelOf(world));
    zones.push({
      position: new THREE.Vector3(spot.x, terrainHeight, spot.z),
      radius: radius,
      name: spot.name,
      delivered: false,
    });
  }
  return zones;
}

function publishRingsToWorld(world, rings) {
  if (!world) return;
  if (typeof world.placeRings === 'function') {
    world.placeRings(rings);
  } else if (Array.isArray(world.rings)) {
    world.rings.length = 0;
    for (const ring of rings) world.rings.push(ring);
  }
  if (typeof world.setRingState === 'function') {
    for (const ring of rings) world.setRingState(ring, ring.state);
  }
}

function publishDropZonesToWorld(world, zones) {
  if (!world) return;
  if (typeof world.placeDropZones === 'function') {
    world.placeDropZones(zones);
  } else if (Array.isArray(world.dropZones)) {
    world.dropZones.length = 0;
    for (const zone of zones) world.dropZones.push(zone);
  }
}

function windForMission(definition) {
  const tierWind = WIND_BY_TIER[definition.tier] || WIND_BY_TIER[1];
  const sortieIndex = MISSIONS.findIndex(function (entry) { return entry.id === definition.id; });
  const dirDeg = (sortieIndex * 47 + 30) % 360;
  const radians = (dirDeg * Math.PI) / 180;
  // Wind vector points where the air moves toward.
  const vector = new THREE.Vector3(Math.sin(radians), 0, -Math.cos(radians)).multiplyScalar(tierWind.speed);
  return { dirDeg: dirDeg, speed: tierWind.speed, gustAmp: tierWind.gustAmp, vector: vector };
}

function placePlaneForAirborneStart(plane, targetStrip, approachOffsetDeg) {
  if (!plane || !targetStrip) return;
  const forward = headingToForwardVector(targetStrip.headingDeg);
  const right = headingToRightVector(targetStrip.headingDeg);
  const offsetRadians = ((approachOffsetDeg || 0) * Math.PI) / 180;
  const approachDirection = forward.clone().multiplyScalar(Math.cos(offsetRadians))
    .addScaledVector(right, Math.sin(offsetRadians)).normalize();
  const startPosition = targetStrip.position.clone()
    .addScaledVector(approachDirection, -1500)
    .add(new THREE.Vector3(0, 300, 0));
  if (plane.position && plane.position.isVector3) plane.position.copy(startPosition);
  if (plane.velocity && plane.velocity.isVector3) {
    plane.velocity.copy(approachDirection).multiplyScalar(30);
  }
  plane.headingDeg = (targetStrip.headingDeg + (approachOffsetDeg || 0) + 360) % 360;
  plane.airspeed = 30;
  plane.verticalSpeed = 0;
  plane.onGround = false;
  plane.throttle = 0.55;
  plane.engineOn = true;
}

export function startMission(missionId, sim, world) {
  const definition = getMissionDef(missionId);
  const strips = resolveStrips(world);
  const homeStrip = findStripById(strips, 'aurora') || strips[0];

  // D-141 startup assert: every strip id named by a mission definition
  // must resolve against the world's strips. A mismatch previously sent
  // deliveries to the wrong island with no signal at all.
  for (const entry of MISSION_DEFINITIONS) {
    const wantedId = entry.destinationStripId || entry.targetStripId;
    if (wantedId && !findStripById(strips, wantedId)) {
      console.warn('[missions] D-141: mission "' + entry.id + '" strip id "' + wantedId
        + '" does not resolve against world strips [' + strips.map(function (s) { return s.id; }).join(', ') + ']');
    }
  }
  const plane = sim.plane || null;

  const mission = {
    id: missionId,
    type: definition ? definition.type : 'free-flight',
    tier: definition ? definition.tier : 1,
    title: definition ? definition.title : 'Free Flight',
    briefing: definition ? definition.briefing : 'The whole archipelago, no objectives. Refuel and repair at any strip.',
    maxScore: definition ? definition.maxScore : 0,
    parTime: 0,
    objective: '',
    phase: 'objective',
    score: 0,
    breakdown: [],
    elapsed: 0,
    rings: [],
    nextRingIndex: 0,
    ringsHit: 0,
    ringsMissed: 0,
    dropZones: [],
    activeZoneIndex: 0,
    parcelsAboard: 0,
    parcelsDelivered: 0,
    parcels: [],
    destinationStrip: null,
    targetStrip: null,
    homeStrip: homeStrip,
    strips: strips,
    unloaded: false,
    unloadTimer: 0,
    unloadProgress: 0,
    touchdownGrade: null,
    finalTouchdownGrade: null,
    outboundLandingBonusPaid: false,
    goArounds: 0,
    approachArmed: false,
    engineOut: false,
    engineOutCount: 0,
    engineOutRecoveries: 0,
    refuelProgress: null,
    repairProgress: null,
    wind: definition ? windForMission(definition) : { dirDeg: 0, speed: 0, gustAmp: 0, vector: new THREE.Vector3() },
    targetPosition: null,
    targetLabel: '',
    // HUD contract (D-03): { label, position: Vector3, distance,
    // bearingDeg } — refreshed every stepMission by updateNextTarget.
    target: null,
    progressText: '',
    complete: false,
    failed: false,
    ended: false,
    endReason: '',
    finalised: false,
    result: null,
    prevPosition: plane && plane.position ? plane.position.clone() : new THREE.Vector3(),
    prevVerticalSpeed: 0,
    prevOnGround: plane ? Boolean(plane.onGround) : true,
    // D-142: the full-stop sortie-end check is only armed once the plane
    // has actually flown (or at least rolled fast) this sortie. A parked
    // plane at spawn must never end the sortie.
    hasBeenAirborne: false,
    hasMoved: false,
    crashReason: null,
    crashVerdict: null,
    stopTimer: 0,
    stoppedOnStrip: null,
    damageTaken: 0,
    prevDamage: plane ? (plane.damage || 0) : 0,
    fuelLowWarned: false,
    fuelCriticalWarned: false,
    crashSeen: false,
    world: world || null,
    scene: sim.scene || null,
  };

  // Fuel and damage start state (design.md section 2.5: Tier 3 starts at 85%).
  if (plane) {
    plane.fuel = mission.tier === 3 ? 0.85 : 1;
    plane.damage = 0;
    mission.prevDamage = 0;
    if (plane.engineOn === undefined) plane.engineOn = true;
  }

  if (definition && definition.type === 'ring') {
    mission.rings = buildRingsForMission(definition, world);
    publishRingsToWorld(world, mission.rings);
    const startPosition = plane && plane.position ? plane.position : homeStrip.position;
    mission.parTime = routeLengthMetres(mission.rings, startPosition) / 38 + 45;
    setObjective(sim, mission, 'Thread the rings in order — ring 1 of ' + mission.rings.length + '.');
    mission.progressText = 'Ring 0/' + mission.rings.length;
  } else if (definition && definition.type === 'cargo') {
    mission.dropZones = buildDropZonesForMission(definition, world);
    publishDropZonesToWorld(world, mission.dropZones);
    mission.parcelsAboard = mission.dropZones.length;
    setObjective(sim, mission, 'Drop a parcel on the marked zone at ' + (mission.dropZones[0] ? mission.dropZones[0].name : 'the target') + '.');
    mission.progressText = 'Parcels 0/' + mission.dropZones.length;
  } else if (definition && definition.type === 'delivery') {
    mission.destinationStrip = findStripById(strips, definition.destinationStripId) || strips[1] || homeStrip;
    const legDistance = homeStrip.position.distanceTo(mission.destinationStrip.position);
    mission.parTime = (legDistance * 2) / 30 + 120;
    setObjective(sim, mission, 'Deliver the mail to ' + mission.destinationStrip.name + '.');
  } else if (definition && definition.type === 'precision') {
    mission.targetStrip = findStripById(strips, definition.targetStripId) || homeStrip;
    if (definition.airborneStart) {
      placePlaneForAirborneStart(plane, mission.targetStrip, definition.approachOffsetDeg);
      if (plane && plane.position) mission.prevPosition.copy(plane.position);
      mission.prevOnGround = false;
      mission.hasBeenAirborne = true; // starts airborne: end check armed (D-142)
    }
    setObjective(sim, mission, 'Land on ' + mission.targetStrip.name + ' — gentle sink, centreline, 22–26 m/s.');
  } else {
    setObjective(sim, mission, 'Free flight — land at any strip to refuel and repair.');
  }

  sim.mission = mission;
  sim.score = 0;
  sim.wind = mission.wind;
  updateNextTarget(sim, mission);
  pushEvent(sim, { type: 'missionStarted', missionId: missionId, title: mission.title });
  return mission;
}

// ---------------------------------------------------------------------------
// Next-target guidance for the HUD arrow
// ---------------------------------------------------------------------------

function updateNextTarget(sim, mission) {
  const plane = sim.plane;
  let target = null;
  let label = '';

  if (mission.engineOut && plane) {
    const strip = nearestStrip(mission.strips, plane.position);
    if (strip) {
      target = strip.position;
      label = strip.name;
    }
  } else if (mission.type === 'ring' && mission.nextRingIndex < mission.rings.length) {
    target = mission.rings[mission.nextRingIndex].position;
    label = 'Ring ' + (mission.nextRingIndex + 1);
  } else if (mission.type === 'cargo' && mission.activeZoneIndex < mission.dropZones.length) {
    const zone = mission.dropZones[mission.activeZoneIndex];
    target = zone.position;
    label = zone.name;
  } else if (mission.type === 'delivery') {
    if (!mission.unloaded && mission.destinationStrip) {
      target = parkingBoxCentre(mission.destinationStrip);
      label = mission.destinationStrip.name;
    } else if (mission.homeStrip) {
      target = mission.homeStrip.position;
      label = mission.homeStrip.name;
    }
  } else if (mission.type === 'precision' && mission.targetStrip) {
    target = mission.targetStrip.position;
    label = mission.targetStrip.name;
  } else if (mission.homeStrip) {
    target = mission.homeStrip.position;
    label = mission.homeStrip.name;
  }

  // D-133: this runs every substep, so targetPosition and target are
  // persistent objects updated in place instead of clone() + a fresh
  // object per call. Readers (hud.js) extract the values synchronously
  // each frame, so in-place updates are indistinguishable from snapshots.
  if (target) {
    if (!mission.targetPosition || !mission.targetPosition.isVector3) {
      mission.targetPosition = new THREE.Vector3();
    }
    mission.targetPosition.copy(target);
  } else {
    mission.targetPosition = null;
  }
  mission.targetLabel = label;

  // HUD target (D-03): hud.js reads mission.target defensively as
  // target{label, distance, bearingDeg, position} — provide all four.
  // distance = horizontal (ground) distance in metres, matching the
  // HUD's own position-derived fallback; bearingDeg = absolute bearing
  // to the target, 0 = north (-Z), degrees clockwise 0..360 (the HUD
  // derives relative bearing as bearingDeg - plane.headingDeg).
  if (target) {
    if (!mission.target || !mission.target.position || !mission.target.position.isVector3) {
      mission.target = { label: '', position: new THREE.Vector3(), distance: null, bearingDeg: null };
    }
    mission.target.label = label;
    mission.target.position.copy(target);
    if (plane && plane.position) {
      const dx = target.x - plane.position.x;
      const dz = target.z - plane.position.z;
      mission.target.distance = Math.sqrt(dx * dx + dz * dz);
      let bearingDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
      if (bearingDeg < 0) bearingDeg += 360;
      mission.target.bearingDeg = bearingDeg;
    } else {
      mission.target.distance = null;
      mission.target.bearingDeg = null;
    }
  } else {
    mission.target = null;
  }
}

// ---------------------------------------------------------------------------
// Cargo parcels (ballistic + parachute, with a visible mesh)
// ---------------------------------------------------------------------------

let sharedParcelGeometry = null;
let sharedCanopyGeometry = null;
let sharedParcelMaterial = null;
let sharedCanopyMaterial = null;
let sharedShroudGeometry = null;
let sharedShroudMaterial = null;

// VD-03 (visual only): parcel = mail crate + parachute. Box detail
// (planks, 2 straps, POST label) is one 256px canvas texture so the
// crate stays a single draw; canopy rim band is vertex colour; the 4
// shroud lines are one LineSegments (+1 draw max per spec §7).
function makeParcelTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9A6B3F';
  ctx.fillRect(0, 0, 256, 256);
  // Wood planks + grain.
  ctx.strokeStyle = 'rgba(70,45,20,0.55)';
  ctx.lineWidth = 3;
  for (const y of [64, 128, 192]) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(120,85,45,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const y = 8 + i * 10;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y + ((i % 3) - 1) * 2); ctx.stroke();
  }
  // Edge battens.
  ctx.fillStyle = 'rgba(110,75,38,0.9)';
  ctx.fillRect(0, 0, 256, 14); ctx.fillRect(0, 242, 256, 14);
  ctx.fillRect(0, 0, 14, 256); ctx.fillRect(242, 0, 14, 256);
  // Two dark straps.
  ctx.fillStyle = '#2E3236';
  ctx.fillRect(58, 0, 26, 256);
  ctx.fillRect(172, 0, 26, 256);
  // Cream mail label with POST text (spec §3.1 stack).
  ctx.fillStyle = '#F2EDE4';
  ctx.fillRect(92, 84, 72, 88);
  ctx.strokeStyle = '#D64541';
  ctx.lineWidth = 4;
  ctx.strokeRect(96, 88, 64, 80);
  ctx.fillStyle = '#D64541';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 26px "Segoe UI", system-ui, Arial, sans-serif';
  ctx.fillText('POST', 128, 112);
  ctx.fillStyle = '#2E3236';
  ctx.font = '700 13px "Segoe UI", system-ui, Arial, sans-serif';
  ctx.fillText('AIR MAIL', 128, 140);
  ctx.font = '700 11px "Segoe UI", system-ui, Arial, sans-serif';
  ctx.fillText('FRAGILE', 128, 158);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeCanopyGeometry() {
  const geometry = new THREE.SphereGeometry(1.1, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  // Vertex colours: cream canopy with alternating gore shading (reads
  // as a parachute from above), mail-red rim band (lowest ring).
  const positions = geometry.attributes.position;
  const colours = new Float32Array(positions.count * 3);
  const cream = new THREE.Color(0xf2ede4);
  const gore = cream.clone().multiplyScalar(0.88); // VD-24: derived cream shade, no off-palette hex (was 0xd9cdb4)
  const red = new THREE.Color(0xd64541);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    let c = cream;
    if (y < 0.22) c = red;
    else if (Math.floor(((Math.atan2(x, z) + Math.PI) / (Math.PI * 2)) * 8) % 2 === 0) c = gore;
    colours[i * 3] = c.r; colours[i * 3 + 1] = c.g; colours[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

// 4 shroud lines as merged thin cylinders (one draw, visible at 256px
// where 1px LineSegments vanish). Manual merge: no utils import.
function makeShroudGeometry() {
  const rim = 1.1 / Math.SQRT2;
  const parts = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const top = new THREE.Vector3(sx * rim, 1.1, sz * rim);
      const bottom = new THREE.Vector3(sx * 0.3, 0.2, sz * 0.3);
      const dir = bottom.clone().sub(top);
      const len = dir.length();
      const cyl = new THREE.CylinderGeometry(0.018, 0.018, len, 5, 1, true).toNonIndexed();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir.normalize());
      const mid = top.clone().add(bottom).multiplyScalar(0.5);
      cyl.applyMatrix4(new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1)));
      parts.push(cyl);
    }
  }
  let total = 0;
  for (const part of parts) total += part.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let offset = 0;
  for (const part of parts) {
    pos.set(part.attributes.position.array, offset * 3);
    nor.set(part.attributes.normal.array, offset * 3);
    offset += part.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return merged;
}

function buildParcelMesh() {
  if (!sharedParcelGeometry) {
    sharedParcelGeometry = new THREE.BoxGeometry(0.6, 0.4, 0.6);
    sharedCanopyGeometry = makeCanopyGeometry();
    const parcelTexture = makeParcelTexture();
    sharedParcelMaterial = new THREE.MeshStandardMaterial({
      map: parcelTexture, emissiveMap: parcelTexture, emissive: 0xffffff,
      emissiveIntensity: 0.18, flatShading: true, roughness: 0.85, metalness: 0.0,
    });
    sharedCanopyMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, emissive: 0xf2ede4, emissiveIntensity: 0.22,
      flatShading: true, roughness: 0.8, metalness: 0.0, side: THREE.DoubleSide,
    });
    sharedShroudGeometry = makeShroudGeometry();
    sharedShroudMaterial = new THREE.MeshStandardMaterial({
      color: 0x2e3236, flatShading: true, roughness: 0.9, metalness: 0.0,
    });
  }
  const group = new THREE.Group();
  const box = new THREE.Mesh(sharedParcelGeometry, sharedParcelMaterial);
  box.name = 'parcel-box';
  const chute = new THREE.Group();
  chute.name = 'parcel-canopy';
  const canopy = new THREE.Mesh(sharedCanopyGeometry, sharedCanopyMaterial);
  canopy.position.y = 1.1;
  const shrouds = new THREE.Mesh(sharedShroudGeometry, sharedShroudMaterial);
  chute.add(canopy);
  chute.add(shrouds);
  chute.visible = false;
  group.add(box);
  group.add(chute);
  group.userData.canopy = chute;
  return group;
}

export function dropParcel(sim) {
  const mission = sim.mission;
  const plane = sim.plane;
  if (!mission || !plane || mission.type !== 'cargo') return null;
  if (mission.parcelsAboard <= 0 || plane.onGround) return null;
  if ((plane.altitudeAgl || 0) < 5) return null;

  const parcel = {
    position: plane.position.clone(),
    velocity: plane.velocity ? plane.velocity.clone() : new THREE.Vector3(),
    age: 0,
    chuteOpen: false,
    landed: false,
    mesh: buildParcelMesh(),
    zoneIndex: mission.activeZoneIndex,
  };
  parcel.mesh.position.copy(parcel.position);
  const scene = sim.scene || mission.scene;
  if (scene && typeof scene.add === 'function') scene.add(parcel.mesh);
  mission.parcels.push(parcel);
  mission.parcelsAboard -= 1;
  pushEvent(sim, { type: 'parcelDropped', parcelsAboard: mission.parcelsAboard });
  return parcel;
}

function removeParcelMesh(sim, mission, parcel) {
  const scene = sim.scene || mission.scene;
  if (parcel.mesh && scene && typeof scene.remove === 'function') scene.remove(parcel.mesh);
  parcel.mesh = null;
}

function scoreParcelLanding(sim, mission, parcel) {
  const world = mission.world;
  const groundHeight = groundHeightAt(world, parcel.position.x, parcel.position.z);
  const inSea = groundHeight <= seaLevelOf(world) + 0.2;
  const zone = mission.dropZones[parcel.zoneIndex] || mission.dropZones[mission.activeZoneIndex];

  if (inSea || !zone) {
    pushEvent(sim, { type: 'parcelLost', reason: inSea ? 'sea' : 'no-zone' });
    pushEvent(sim, { type: 'toast', message: 'Parcel lost' });
  } else {
    const dx = parcel.position.x - zone.position.x;
    const dz = parcel.position.z - zone.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance <= zone.radius) {
      const points = DROP_BASE_POINTS + DROP_BULLSEYE_BONUS * (1 - distance / zone.radius);
      addScore(sim, mission, 'Parcel delivered — ' + zone.name, points);
      mission.parcelsDelivered += 1;
      zone.delivered = true;
      pushEvent(sim, { type: 'parcelLanded', zone: zone.name, distance: distance, inside: true });
    } else if (distance <= DROP_NEAR_MISS_RADIUS) {
      const points = DROP_NEAR_MISS_POINTS * (1 - distance / DROP_NEAR_MISS_RADIUS);
      addScore(sim, mission, 'Parcel near miss — ' + zone.name, points);
      pushEvent(sim, { type: 'parcelLanded', zone: zone.name, distance: distance, inside: false });
    } else {
      pushEvent(sim, { type: 'parcelLost', reason: 'wide', distance: distance });
      pushEvent(sim, { type: 'toast', message: 'Parcel lost' });
    }
  }

  if (parcel.zoneIndex >= mission.activeZoneIndex) {
    mission.activeZoneIndex = Math.min(parcel.zoneIndex + 1, mission.dropZones.length);
  }
  mission.progressText = 'Parcels ' + mission.parcelsDelivered + '/' + mission.dropZones.length;

  if (mission.activeZoneIndex >= mission.dropZones.length && mission.parcelsAboard <= 0) {
    mission.phase = 'return';
    setObjective(sim, mission, 'All parcels away — land at any strip (home pays a bonus).');
  } else {
    const nextZone = mission.dropZones[mission.activeZoneIndex];
    if (nextZone) setObjective(sim, mission, 'Drop a parcel on the marked zone at ' + nextZone.name + '.');
  }
}

function stepParcels(sim, mission, dt) {
  const world = mission.world;
  const windVector = mission.wind ? mission.wind.vector : new THREE.Vector3();
  for (let i = mission.parcels.length - 1; i >= 0; i--) {
    const parcel = mission.parcels[i];
    parcel.age += dt;
    parcel.velocity.y -= PARCEL_GRAVITY * dt;
    if (parcel.age >= PARCEL_CHUTE_DELAY_SECONDS) {
      parcel.chuteOpen = true;
      const blend = Math.min(1, 2 * dt);
      parcel.velocity.y += (-PARCEL_CHUTE_TERMINAL_SPEED - parcel.velocity.y) * blend;
      const driftBlend = Math.min(1, 0.8 * dt);
      parcel.velocity.x += (windVector.x - parcel.velocity.x) * driftBlend;
      parcel.velocity.z += (windVector.z - parcel.velocity.z) * driftBlend;
    } else {
      const driftBlend = Math.min(1, 0.2 * dt);
      parcel.velocity.x += (windVector.x - parcel.velocity.x) * driftBlend;
      parcel.velocity.z += (windVector.z - parcel.velocity.z) * driftBlend;
    }
    parcel.position.addScaledVector(parcel.velocity, dt);

    if (parcel.mesh) {
      parcel.mesh.position.copy(parcel.position);
      parcel.mesh.rotation.z = Math.sin(parcel.age * 1.7) * 0.12;
      if (parcel.mesh.userData.canopy) parcel.mesh.userData.canopy.visible = parcel.chuteOpen;
    }

    const groundHeight = Math.max(groundHeightAt(world, parcel.position.x, parcel.position.z), seaLevelOf(world));
    if (parcel.position.y <= groundHeight) {
      parcel.position.y = groundHeight;
      parcel.landed = true;
      scoreParcelLanding(sim, mission, parcel);
      removeParcelMesh(sim, mission, parcel);
      mission.parcels.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Ring course detection (plane-crossing test, design.md section 2.1)
// ---------------------------------------------------------------------------

function setRingVisualState(mission, ring, state) {
  ring.state = state;
  const world = mission.world;
  if (world && typeof world.setRingState === 'function') world.setRingState(ring, state);
}

function advanceToNextRing(sim, mission) {
  mission.nextRingIndex += 1;
  mission.progressText = 'Ring ' + mission.ringsHit + '/' + mission.rings.length;
  if (mission.nextRingIndex < mission.rings.length) {
    setRingVisualState(mission, mission.rings[mission.nextRingIndex], 'next');
    setObjective(sim, mission, 'Thread the rings in order — ring ' + (mission.nextRingIndex + 1) + ' of ' + mission.rings.length + '.');
  } else {
    mission.phase = 'return';
    setObjective(sim, mission, 'Course complete — land at any strip (home pays a bonus).');
  }
}

// D-133: scratch vectors for the ring test (was 4 fresh Vector3 per
// substep), plus a distance gate: the crossing test only runs when the
// plane is close enough that a crossing point could land within the
// miss band (radius × 2.5, +2 m covers one substep of travel). Farther
// out the old code computed the same sides and fell through to the
// past-the-ring check below, which still runs every substep.
const _ringNormal = new THREE.Vector3();
const _ringDelta = new THREE.Vector3();
const _ringCrossing = new THREE.Vector3();

function stepRingCourse(sim, mission) {
  const plane = sim.plane;
  if (mission.nextRingIndex >= mission.rings.length) return;
  const ring = mission.rings[mission.nextRingIndex];
  const previous = mission.prevPosition;
  const current = plane.position;

  _ringDelta.subVectors(current, ring.position);
  const nearGate = ring.radius * 2.5 + 2;
  if (_ringDelta.lengthSq() <= nearGate * nearGate) {
    _ringNormal.set(0, 0, 1).applyQuaternion(ring.quaternion);
    const currentSide = _ringDelta.dot(_ringNormal);
    _ringDelta.subVectors(previous, ring.position);
    const previousSide = _ringDelta.dot(_ringNormal);

    if (previousSide !== 0 && currentSide !== 0 && Math.sign(previousSide) !== Math.sign(currentSide)) {
      const fraction = previousSide / (previousSide - currentSide);
      const crossingPoint = _ringCrossing.copy(previous).lerp(current, fraction);
      const radialOffset = crossingPoint.distanceTo(ring.position);
      const velocityAlongRoute = plane.velocity ? plane.velocity.dot(ring.forward) : 1;
      if (radialOffset <= ring.radius) {
        if (velocityAlongRoute < 0) {
          pushEvent(sim, { type: 'ringWrongWay', ringIndex: mission.nextRingIndex });
          pushEvent(sim, { type: 'toast', message: 'Wrong way through the ring' });
          return;
        }
        const centreBonus = RING_CENTRE_BONUS * (1 - radialOffset / ring.radius);
        addScore(sim, mission, 'Ring ' + (mission.nextRingIndex + 1), RING_POINTS + centreBonus);
        mission.ringsHit += 1;
        setRingVisualState(mission, ring, 'done');
        pushEvent(sim, { type: 'ringHit', ringIndex: mission.nextRingIndex, offset: radialOffset });
        advanceToNextRing(sim, mission);
        return;
      }
      if (radialOffset <= ring.radius * 2.5) {
        mission.ringsMissed += 1;
        setRingVisualState(mission, ring, 'done');
        pushEvent(sim, { type: 'ringMiss', ringIndex: mission.nextRingIndex, offset: radialOffset });
        pushEvent(sim, { type: 'toast', message: 'Ring missed' });
        advanceToNextRing(sim, mission);
        return;
      }
    }
  }

  // Flew well past the ring without crossing near it: count it missed.
  _ringDelta.subVectors(current, ring.position);
  const pastDistance = _ringDelta.dot(ring.forward);
  if (pastDistance > 500 && _ringDelta.lengthSq() < 900 * 900) {
    mission.ringsMissed += 1;
    setRingVisualState(mission, ring, 'done');
    pushEvent(sim, { type: 'ringMiss', ringIndex: mission.nextRingIndex, offset: -1 });
    advanceToNextRing(sim, mission);
  }
}

// ---------------------------------------------------------------------------
// Fuel warnings, engine-out, refuel and repair (design.md section 3).
// Burn itself is flight.js's job (D-01) — see note at FUEL_LOW_FRACTION.
// ---------------------------------------------------------------------------

function stepFuelAndServicing(sim, mission, dt, currentStrip, groundSpeed) {
  const plane = sim.plane;

  // No fuel burn here: flight.js burnFuel() already decremented
  // plane.fuel this step (D-01). Only warnings, engine-out detection
  // and the parked refuel/repair timers live in this module.

  if (!mission.fuelLowWarned && plane.fuel <= FUEL_LOW_FRACTION && plane.fuel > FUEL_CRITICAL_FRACTION) {
    mission.fuelLowWarned = true;
    pushEvent(sim, { type: 'fuelLow', fuel: plane.fuel });
  }
  if (!mission.fuelCriticalWarned && plane.fuel <= FUEL_CRITICAL_FRACTION && plane.fuel > 0) {
    mission.fuelCriticalWarned = true;
    pushEvent(sim, { type: 'fuelCritical', fuel: plane.fuel });
  }

  if (plane.fuel <= 0 && !mission.engineOut) {
    mission.engineOut = true;
    mission.engineOutCount += 1;
    plane.engineOn = false;
    addScore(sim, mission, 'Engine-out recovery penalty', -ENGINE_OUT_PENALTY);
    pushEvent(sim, { type: 'engineOut' });
    setObjective(sim, mission, 'ENGINE OUT — GLIDE TO A STRIP');
  }

  const parkedOnStrip = plane.onGround && currentStrip && groundSpeed < FULL_STOP_SPEED;
  if (parkedOnStrip) {
    if (plane.fuel < 1) {
      if (mission.refuelProgress === null) {
        mission.refuelProgress = plane.fuel;
        pushEvent(sim, { type: 'refuelStart' });
      }
      plane.fuel = clampValue(plane.fuel + dt / REFUEL_SECONDS, 0, 1);
      mission.refuelProgress = plane.fuel;
      if (plane.fuel >= 1) {
        mission.refuelProgress = null;
        mission.fuelLowWarned = false;
        mission.fuelCriticalWarned = false;
        if (mission.engineOut) {
          mission.engineOut = false;
          mission.engineOutRecoveries += 1;
          plane.engineOn = true;
        }
        pushEvent(sim, { type: 'refueled' });
      }
    }
    if (plane.damage > 0) {
      if (mission.repairProgress === null) {
        mission.repairProgress = 1 - plane.damage;
        pushEvent(sim, { type: 'repairStart' });
      }
      plane.damage = clampValue(plane.damage - dt / REPAIR_SECONDS, 0, 1);
      mission.repairProgress = 1 - plane.damage;
      if (plane.damage <= 0) {
        mission.repairProgress = null;
        pushEvent(sim, { type: 'repaired' });
      }
    }
  } else {
    mission.refuelProgress = null;
    mission.repairProgress = null;
  }
}

// ---------------------------------------------------------------------------
// Touchdown, go-around and mission-end detection
// ---------------------------------------------------------------------------

function readPlaneCrashEvent(plane) {
  if (!plane || !Array.isArray(plane.events)) return null;
  for (const event of plane.events) {
    if (event && event.type === 'crash') return event;
  }
  return null;
}

function readPlaneTouchdownEvent(plane) {
  if (!plane || !Array.isArray(plane.events)) return null;
  let latest = null;
  for (const event of plane.events) {
    if (event && event.type === 'touchdown') latest = event;
  }
  return latest;
}

function handleTouchdown(sim, mission, currentStrip) {
  const plane = sim.plane;
  const touchdownEvent = readPlaneTouchdownEvent(plane);
  const sinkRate = touchdownEvent && typeof touchdownEvent.sinkRate === 'number'
    ? touchdownEvent.sinkRate
    : mission.prevVerticalSpeed;
  const grade = gradeTouchdown(plane, currentStrip, sinkRate);
  mission.finalTouchdownGrade = grade;
  pushEvent(sim, { type: 'touchdownGrade', grade: grade });

  if (mission.type === 'precision' && !mission.touchdownGrade) {
    mission.touchdownGrade = grade;
    if (grade.onStrip && currentStrip && mission.targetStrip && currentStrip.id === mission.targetStrip.id) {
      addScore(sim, mission, 'Touchdown grade', grade.total);
    }
    setObjective(sim, mission, 'Touchdown graded — roll to a stop on the strip.');
  }

  if (mission.type === 'delivery' && !mission.unloaded && currentStrip
    && mission.destinationStrip && currentStrip.id === mission.destinationStrip.id
    && !mission.outboundLandingBonusPaid) {
    mission.outboundLandingBonusPaid = true;
    const bonus = landingBonusFromGrade(grade);
    if (bonus > 0) addScore(sim, mission, 'Outbound landing bonus', bonus);
  }
}

function stepGoAroundDetection(sim, mission) {
  const plane = sim.plane;
  if (mission.type !== 'precision' || mission.touchdownGrade) return;
  const altitudeAgl = plane.altitudeAgl || 0;
  if (!plane.onGround && altitudeAgl < 50) mission.approachArmed = true;
  if (mission.approachArmed && !plane.onGround && altitudeAgl > 100) {
    mission.approachArmed = false;
    mission.goArounds += 1;
    if (mission.goArounds <= MAX_GO_AROUND_PENALTIES) {
      addScore(sim, mission, 'Go-around penalty', -GO_AROUND_PENALTY);
    }
    pushEvent(sim, { type: 'goAround', count: mission.goArounds });
    setObjective(sim, mission, 'Go-around — fly another approach to ' + (mission.targetStrip ? mission.targetStrip.name : 'the strip') + '.');
  }
}

function objectiveIsComplete(mission) {
  if (mission.type === 'ring') return mission.nextRingIndex >= mission.rings.length;
  if (mission.type === 'cargo') {
    return mission.activeZoneIndex >= mission.dropZones.length
      && mission.parcelsAboard <= 0 && mission.parcels.length === 0;
  }
  if (mission.type === 'delivery') return mission.unloaded;
  if (mission.type === 'precision') return Boolean(mission.touchdownGrade);
  return false;
}

function endMission(sim, mission, complete, reason) {
  if (mission.ended) return;
  mission.ended = true;
  mission.complete = complete;
  mission.failed = !complete;
  mission.endReason = reason;
  mission.phase = 'done';
  pushEvent(sim, { type: complete ? 'missionComplete' : 'missionFailed', reason: reason, missionId: mission.id });
}

function stepDeliveryUnload(sim, mission, dt, currentStrip, groundSpeed) {
  const plane = sim.plane;
  if (mission.type !== 'delivery' || mission.unloaded) return false;
  const atDestination = currentStrip && mission.destinationStrip
    && currentStrip.id === mission.destinationStrip.id;
  if (!atDestination) return false;

  const stoppedInBox = plane.onGround && groundSpeed < FULL_STOP_SPEED
    && isInsideParkingBox(mission.destinationStrip, plane.position);
  if (stoppedInBox) {
    mission.unloadTimer += dt;
    mission.unloadProgress = clampValue(mission.unloadTimer / UNLOAD_SECONDS, 0, 1);
    setObjective(sim, mission, 'Unloading the mail…');
    if (mission.unloadTimer >= UNLOAD_SECONDS) {
      mission.unloaded = true;
      mission.unloadProgress = 1;
      addScore(sim, mission, 'Mail unloaded at ' + mission.destinationStrip.name, DELIVERY_UNLOAD_POINTS);
      pushEvent(sim, { type: 'unloadComplete' });
      mission.phase = 'return';
      setObjective(sim, mission, 'Mail delivered — fly home to Aurora Field and stop.');
    }
    return true; // suppress sortie-end while unloading at the destination
  }
  mission.unloadTimer = 0;
  mission.unloadProgress = 0;
  if (plane.onGround && atDestination) {
    setObjective(sim, mission, 'Stop in the parking box to unload the mail.');
  }
  return true; // at the destination strip: a stop here never ends the sortie early
}

function stepMissionEnd(sim, mission, dt, currentStrip, groundSpeed, unloadSuppressesEnd) {
  const plane = sim.plane;
  const world = mission.world;

  const crashEvent = readPlaneCrashEvent(plane);
  if (crashEvent && !mission.crashSeen) {
    mission.crashSeen = true;
    // D-145: flight.js crash events carry a raw reason token
    // (terrain/ditch/obstacle/hard-impact); map it to the design
    // section 3.3/3.4 verdict sentence here so debrief/crashed
    // screens never show the bare token.
    mission.crashReason = crashEvent.reason || null;
    mission.crashVerdict = verdictForCrashReason(crashEvent.reason);
    endMission(sim, mission, false, 'crashed');
    return;
  }
  if ((plane.damage || 0) >= 1 && plane.onGround) {
    endMission(sim, mission, false, 'wrecked');
    return;
  }

  const overSea = groundHeightAt(world, plane.position.x, plane.position.z) <= seaLevelOf(world) + 0.3;
  if (plane.onGround && overSea && !currentStrip) {
    endMission(sim, mission, false, 'ditched');
    return;
  }

  // D-142: never end a sortie on a full stop until the plane has flown
  // (or at least rolled fast) this sortie. Without this guard a
  // ground-start spawn — parked on the home strip at speed 0 — ended
  // itself ~1 s after launch before the player could act.
  if (!mission.hasBeenAirborne && !mission.hasMoved) {
    mission.stopTimer = 0;
    return;
  }

  if (plane.onGround && groundSpeed < FULL_STOP_SPEED) {
    mission.stopTimer += dt;
  } else {
    mission.stopTimer = 0;
    mission.stoppedOnStrip = null;
  }
  if (mission.stopTimer < FULL_STOP_HOLD_SECONDS) return;

  // Full stop reached.
  if (!currentStrip) {
    if (mission.engineOut || plane.fuel <= 0) {
      endMission(sim, mission, false, 'forced-landing');
    } else {
      endMission(sim, mission, false, 'off-strip-stop');
    }
    return;
  }

  if (unloadSuppressesEnd) return;
  if (mission.engineOut && mission.engineOutRecoveries < mission.engineOutCount) {
    // Engine-out recovery: refuel on this strip, then the sortie continues.
    return;
  }

  mission.stoppedOnStrip = currentStrip;
  if (mission.type === 'delivery') {
    if (!mission.unloaded) {
      endMission(sim, mission, false, 'diverted-undelivered');
    } else if (mission.homeStrip && currentStrip.id === mission.homeStrip.id) {
      addScore(sim, mission, 'Return home', DELIVERY_RETURN_POINTS);
      endMission(sim, mission, true, 'delivered');
    } else {
      addScore(sim, mission, 'Diverted completion', DELIVERY_DIVERT_POINTS);
      endMission(sim, mission, true, 'diverted');
    }
    return;
  }

  if (mission.type === 'precision') {
    const gradedOnTarget = mission.touchdownGrade && mission.touchdownGrade.onStrip
      && mission.targetStrip && mission.touchdownGrade.stripId === mission.targetStrip.id;
    endMission(sim, mission, Boolean(gradedOnTarget), gradedOnTarget ? 'landed' : 'wrong-strip');
    return;
  }

  endMission(sim, mission, objectiveIsComplete(mission), objectiveIsComplete(mission) ? 'objective-complete' : 'partial');
}

// ---------------------------------------------------------------------------
// Per-frame mission step
// ---------------------------------------------------------------------------

export function stepMission(sim, dt) {
  const mission = sim.mission;
  const plane = sim.plane;
  if (!mission || !plane || mission.ended) return;
  if (typeof dt !== 'number' || dt <= 0) return;

  mission.elapsed += dt;

  // Damage taken during the sortie (cumulative positive deltas).
  const currentDamage = plane.damage || 0;
  if (currentDamage > mission.prevDamage) {
    mission.damageTaken += currentDamage - mission.prevDamage;
  }
  mission.prevDamage = currentDamage;

  const groundSpeed = plane.velocity
    ? Math.sqrt(plane.velocity.x * plane.velocity.x + plane.velocity.z * plane.velocity.z)
    : 0;
  const currentStrip = plane.position ? stripAtPosition(mission.world, mission.strips, plane.position) : null;

  stepFuelAndServicing(sim, mission, dt, currentStrip, groundSpeed);

  if (mission.type === 'ring' && !plane.onGround) stepRingCourse(sim, mission);
  if (mission.type === 'cargo') stepParcels(sim, mission, dt);

  const justTouchedDown = plane.onGround && !mission.prevOnGround;
  if (justTouchedDown) handleTouchdown(sim, mission, currentStrip);
  stepGoAroundDetection(sim, mission);

  // D-142 arming: once the plane leaves the ground (or rolls faster
  // than taxi speed) the full-stop end check may fire. Before that, a
  // parked spawn is inert.
  if (!plane.onGround) mission.hasBeenAirborne = true;
  if (groundSpeed > 5) mission.hasMoved = true;

  const unloadSuppressesEnd = stepDeliveryUnload(sim, mission, dt, currentStrip, groundSpeed);
  stepMissionEnd(sim, mission, dt, currentStrip, groundSpeed, unloadSuppressesEnd);

  if (!plane.onGround) mission.prevVerticalSpeed = plane.verticalSpeed || 0;
  mission.prevOnGround = Boolean(plane.onGround);
  if (plane.position) mission.prevPosition.copy(plane.position);
  updateNextTarget(sim, mission);
}

// ---------------------------------------------------------------------------
// Debrief result (design.md sections 2, 3.4 and 6.2)
// ---------------------------------------------------------------------------

// D-145: flight.js crash events carry raw reason tokens. Map each one
// to its design.md section 3.3 verdict sentence (section 3.4 lists
// these as the debrief "what happened" lines) so no screen ever shows
// a bare token like "terrain" or "hard-impact".
const CRASH_VERDICT_BY_REASON = {
  terrain: "Crashed. Everyone walks away — it's that kind of morning.",
  obstacle: "Crashed. Everyone walks away — it's that kind of morning.",
  'hard-impact': "Crashed. Everyone walks away — it's that kind of morning.",
  ditch: 'Ditched. You and the mail are wet.',
};

export function verdictForCrashReason(reason) {
  return CRASH_VERDICT_BY_REASON[reason]
    || "Crashed. Everyone walks away — it's that kind of morning.";
}

function verdictForResult(mission, grade) {
  if (mission.endReason === 'crashed') {
    return mission.crashVerdict || verdictForCrashReason(mission.crashReason);
  }
  if (mission.endReason === 'wrecked') return 'Wrecked. The islanders will help you rebuild.';
  if (mission.endReason === 'ditched') return 'Ditched. You and the mail are wet.';
  if (mission.endReason === 'forced-landing') return 'Forced landing — out of fuel. The mail is safe, the schedule is not.';
  if (mission.endReason === 'diverted') return 'Down safe at the wrong island. Close enough counts.';
  if (mission.endReason === 'diverted-undelivered') return 'Diverted — mail not delivered.';
  if (mission.type === 'precision' && grade) return grade.verdict;
  if (mission.complete) {
    if (mission.type === 'ring') return "Course flown. Coffee's on.";
    if (mission.type === 'cargo') return "All parcels down. Coffee's on.";
    if (mission.type === 'delivery') return "Mail delivered. Coffee's on.";
    return "Mail delivered. Coffee's on.";
  }
  return 'Some of it got there. The rest is a story now.';
}

function finaliseMission(sim, mission) {
  if (mission.finalised) return;
  mission.finalised = true;
  const plane = sim.plane;

  // Common landing bonus (precision uses the grade itself instead).
  if (mission.type !== 'precision' && mission.type !== 'free-flight') {
    const crashLanding = mission.finalTouchdownGrade
      && (plane ? (plane.damage || 0) : 0) >= 0.4;
    if (mission.finalTouchdownGrade && !crashLanding) {
      const bonus = landingBonusFromGrade(mission.finalTouchdownGrade);
      if (bonus > 0) addScore(sim, mission, 'Landing bonus', bonus);
    }
  }

  // Home-strip bonus on the final stop.
  if (mission.stoppedOnStrip && mission.homeStrip
    && mission.stoppedOnStrip.id === mission.homeStrip.id && mission.type !== 'free-flight') {
    addScore(sim, mission, 'Home strip bonus', HOME_STRIP_BONUS);
  }

  // Fuel bonus (doubled for cargo).
  if (plane && mission.type !== 'free-flight') {
    const perPercent = mission.type === 'cargo' ? FUEL_BONUS_PER_PERCENT * 2 : FUEL_BONUS_PER_PERCENT;
    const fuelBonus = Math.round(perPercent * 100 * clampValue(plane.fuel || 0, 0, 1));
    if (fuelBonus > 0) addScore(sim, mission, 'Fuel remaining bonus', fuelBonus);
  }

  // Time bonus where par applies.
  if ((mission.type === 'ring' || mission.type === 'delivery') && mission.parTime > 0 && mission.complete) {
    const secondsUnderPar = mission.parTime - mission.elapsed;
    if (secondsUnderPar > 0) {
      const timeBonus = Math.min(TIME_BONUS_CAP, Math.round(secondsUnderPar * TIME_BONUS_PER_SECOND));
      if (timeBonus > 0) addScore(sim, mission, 'Time bonus', timeBonus);
    }
  }

  // Damage penalty on damage taken during the sortie.
  if (mission.type !== 'free-flight' && mission.damageTaken > 0) {
    const penalty = Math.round(DAMAGE_PENALTY_PER_PERCENT * 100 * mission.damageTaken);
    if (penalty > 0) addScore(sim, mission, 'Damage penalty', -penalty);
  }

  mission.score = Math.max(0, mission.score);
  sim.score = mission.score;
}

export function missionResult(sim) {
  const mission = sim.mission;
  if (!mission) {
    return { score: 0, medal: null, breakdown: [], verdict: '', complete: false, missionId: null };
  }
  if (mission.result) return mission.result;
  finaliseMission(sim, mission);
  const verdict = verdictForResult(mission, mission.touchdownGrade || mission.finalTouchdownGrade);
  const result = {
    score: mission.score,
    medal: medalForScore(mission.score, mission.maxScore),
    breakdown: mission.breakdown.slice(),
    verdict: verdict,
    // D-145: crashed/debrief screens read cause/reason — carry the
    // design verdict sentence here too, never a raw flight.js token.
    cause: verdict,
    crashReason: mission.crashReason || null,
    complete: mission.complete,
    missionId: mission.id,
    endReason: mission.endReason,
    elapsed: mission.elapsed,
    touchdownGrade: mission.touchdownGrade || mission.finalTouchdownGrade,
  };
  mission.result = result;
  return result;
}

// V6 (display only): the route data the menu charts draw — the same
// objects the sorties fly, read-only; nothing here changes a sortie.
export const MISSION_ROUTES = { rings: RING_ROUTES, dropZones: DROP_ZONE_SPOTS };
