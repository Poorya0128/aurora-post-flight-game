// AURORA POST — shared tuning constants (A4 Flight Physics Engineer).
// Constants only, no logic. Every number here comes from design.md
// Appendix A, section 4 (flight-feel targets), section 5 (world layout),
// section 3 (fuel and damage economy) and section 2.5 (difficulty tiers).
// Units: metres, seconds, metres per second, degrees where named.
// World axes: +X east, +Z south, +Y up. Heading 0 = north (-Z), clockwise.

// ---------------------------------------------------------------------------
// Flat constants (design.md Appendix A names, units spelled out)
// ---------------------------------------------------------------------------

// Flight speeds and performance (design.md section 4.1, sea level, calm)
export const STALL_SPEED = 18; // m/s, clean wing; below this the plane mushes
export const ROTATE_SPEED = 22; // m/s, lift off with a gentle pull
export const BEST_CLIMB_SPEED = 26; // m/s, best climb rate happens here
export const CRUISE_SPEED = 40; // m/s, middle of the efficient 38-42 band
export const MAX_LEVEL_SPEED = 58; // m/s, full throttle, level flight
export const OVERSPEED_SPEED = 65; // m/s, airframe stress starts (dive only)
export const APPROACH_SPEED = 25; // m/s, middle of the 24-27 approach band
export const BEST_GLIDE_SPEED = 28; // m/s, engine-out best glide
export const GLIDE_SINK = 2.2; // m/s sink at best glide (ratio about 13:1)
export const CLIMB_RATE = 5.5; // m/s at best climb speed, full throttle
export const MAX_BANK_DEG = 60; // degrees, steepest bank the stick can hold
export const ROLL_RATE_DEG = 60; // degrees per second toward max bank
export const PITCH_RATE_DEG = 25; // degrees per second, gentle on purpose
export const TURN_RATE_REF_DEG = 18; // degrees per second at 30 deg bank, 35 m/s
export const FLAP_STALL = [18, 17, 16]; // m/s stall speed per flap stage 0, 1, 2

// Fuel economy (design.md section 3.1): burn = 0.04 + 0.26 * throttle per second
export const FUEL_TANK = 100; // fuel units in a full tank (shown as percent)
export const BURN_IDLE = 0.04; // units per second at throttle 0
export const BURN_FULL = 0.30; // units per second at throttle 1
export const FUEL_LOW = 25; // percent, amber warning threshold
export const FUEL_CRITICAL = 10; // percent, red warning threshold

// Damage economy (design.md section 3.2), all values in percent of airframe
export const DMG_HARD_LANDING = [[1.5, 0], [2.5, 5], [3.5, 15], [5, 35], [Infinity, 70]]; // [max sink m/s, damage %]
export const DMG_TERRAIN = 40; // percent, terrain strike above 8 m/s
export const DMG_BUILDING = 50; // percent, building strike above 5 m/s
export const DMG_OVERRUN = 20; // percent, rolling off a strip end above 10 m/s
export const DMG_GRASS_PER_S = 3; // percent per second rolling on grass above 15 m/s
export const DMG_OVERSPEED_PER_S = 2; // percent per second above overspeed, after 2 s sustained
export const REPAIR_TIME = 6; // seconds stopped on a strip to repair to 0%
export const REFUEL_TIME = 4; // seconds stopped on a strip to refuel to 100%

// World extents (design.md section 5.1)
export const WORLD_SIZE = 12000; // metres, playable square centred on origin
export const SOFT_BOUNDARY = 5500; // metres from centre, turn-back warning
export const HARD_BOUNDARY = 6000; // metres from centre, gentle auto-turn assist
export const CEILING = 1200; // metres, soft service ceiling
export const STRIP_WIDTH = 18; // metres, every runway strip

// Scoring (design.md sections 2 and 6, applied by missions.js)
export const RING_POINTS = 250;
export const RING_CENTRE_BONUS = 150;
export const DROP_BASE = 500;
export const DROP_BONUS = 300;
export const DELIVERY_UNLOAD = 1200;
export const DELIVERY_RETURN = 800;
export const DELIVERY_DIVERT = 400;
export const LANDING_BONUS_MAX = 400;
export const HOME_BONUS = 150;
export const FUEL_BONUS_PER_PCT = 2;
export const DAMAGE_PENALTY_PER_PCT = 15;
export const TIME_BONUS_PER_S = 5;
export const TIME_BONUS_CAP = 600;
export const GO_AROUND_PENALTY = 100;
export const ENGINE_OUT_PENALTY = 300;
export const MEDAL_FRACTIONS = { bronze: 0.40, silver: 0.65, gold: 0.85 };

// ---------------------------------------------------------------------------
// Aircraft and aerodynamics (chosen so the section 4.1 targets all hold at
// once; see flight_model.md for the arithmetic and the measured results)
// ---------------------------------------------------------------------------

export const GRAVITY = 9.81; // m/s^2
export const AIR_DENSITY = 1.225; // kg/m^3 at sea level
export const PLANE_MASS = 850; // kg, light bush plane with mail aboard
export const WING_AREA = 20; // m^2, big floaty wing (low wing loading)
export const MAX_THRUST_STATIC = 3175; // newtons at zero airspeed, full throttle
export const THRUST_FALLOFF_PER_MS = 28.6; // newtons lost per m/s of airspeed (propeller)
export const MIN_THRUST = 800; // newtons, floor so a dive can still reach overspeed
export const THROTTLE_EXPONENT = 1.65; // lever to thrust curve (cruise sits at 55-65% lever)
export const LIFT_AT_ZERO_AOA = 0.45; // lift coefficient from wing camber alone
export const LIFT_CURVE_SLOPE = 6.0; // lift coefficient gained per radian of angle of attack
export const FLAP_CLMAX = [2.10, 2.35, 2.65]; // max lift coefficient per flap stage (sets FLAP_STALL)
export const FLAP_LIFT_INCREMENT = [0, 0.25, 0.50]; // extra lift coefficient per flap stage
export const FLAP_DRAG_INCREMENT = [0, 0.02, 0.045]; // extra drag coefficient per flap stage
export const PARASITE_DRAG = 0.033; // drag coefficient floor (fixed gear, bushy airframe)
export const INDUCED_DRAG_FACTOR = 0.045; // drag = PARASITE_DRAG + factor * CL^2 (+ flap drag)
export const STALL_AOA_DEG = 16; // degrees, angle of attack where lift peaks and breaks
export const AUTHORITY_FLOOR = 0.4; // controls never fall below 40% (judge criterion 3)
export const AUTHORITY_REF_SPEED = 35; // m/s where dynamic pressure gives full authority
export const SPOOL_TIME_S = 0.6; // seconds for the engine to spool toward the lever
export const GEAR_HEIGHT_M = 1.1; // metres from plane origin to wheels on the ground
export const TURN_BOOST = 2.1; // arcade turn gain so 30 deg bank gives about 18 deg/s
export const YAW_RATE_DEG = 12; // degrees per second of rudder yaw at full authority
export const BRAKE_DECEL = 4.0; // m/s^2 of wheel braking on the ground
export const ROLLING_FRICTION = 0.06; // ground-roll resistance as a fraction of weight
export const GRASS_FRICTION = 0.35; // off-strip ground resistance as a fraction of weight

// Damage derating bands (design.md section 3.2): as damage grows the engine
// weakens and the controls go sluggish. damage is a fraction 0..1 here.
export const DAMAGE_BANDS = [
  { minDamage: 0.00, powerFactor: 1.00, authorityFactor: 1.00 }, // 0-24%: cosmetic only
  { minDamage: 0.25, powerFactor: 0.90, authorityFactor: 1.00 }, // 25-49%: power -10%
  { minDamage: 0.50, powerFactor: 0.75, authorityFactor: 0.80 }, // 50-74%: power -25%, sluggish
  { minDamage: 0.75, powerFactor: 0.55, authorityFactor: 0.60 }, // 75-99%: power -45%
  { minDamage: 1.00, powerFactor: 0.00, authorityFactor: 0.30 }, // 100%: engine dead, controls slack
];
export const WRECK_SINK_BIAS = 1.5; // extra m/s of sink at 100% damage (design.md 3.3)
export const OVERSPEED_SUSTAIN_S = 2; // seconds above overspeed before stress damage starts
export const TERRAIN_STRIKE_SPEED = 8; // m/s, slower terrain contact is a landing, not a strike
export const TERRAIN_CRASH_SPEED = 20; // m/s, terrain strike at or above this destroys the plane
export const BUILDING_STRIKE_SPEED = 5; // m/s, building contact above this damages
export const BUILDING_CRASH_SPEED = 15; // m/s, building contact at or above this destroys
export const OVERRUN_SPEED = 10; // m/s, leaving a strip end faster than this damages
export const GRASS_DAMAGE_SPEED = 15; // m/s, grass roll faster than this damages per second

// ---------------------------------------------------------------------------
// Grouped exports (the shapes interfaces.md promises to every module)
// ---------------------------------------------------------------------------

export const WORLD = {
  size: WORLD_SIZE,
  seaLevel: 0,
  softBoundary: SOFT_BOUNDARY,
  hardBoundary: HARD_BOUNDARY,
  ceiling: CEILING,
  stripWidth: STRIP_WIDTH,
};

export const PLANE = {
  mass: PLANE_MASS,
  wingArea: WING_AREA,
  maxThrust: MAX_THRUST_STATIC,
  thrustFalloff: THRUST_FALLOFF_PER_MS,
  minThrust: MIN_THRUST,
  gearHeight: GEAR_HEIGHT_M,
};

export const FLIGHT_TUNING = {
  stallSpeed: STALL_SPEED,
  rotateSpeed: ROTATE_SPEED,
  bestClimbSpeed: BEST_CLIMB_SPEED,
  cruiseSpeed: CRUISE_SPEED,
  maxLevelSpeed: MAX_LEVEL_SPEED,
  overspeedSpeed: OVERSPEED_SPEED,
  approachSpeed: APPROACH_SPEED,
  bestGlideSpeed: BEST_GLIDE_SPEED,
  glideSink: GLIDE_SINK,
  climbRate: CLIMB_RATE,
  maxBankDeg: MAX_BANK_DEG,
  rollRateDeg: ROLL_RATE_DEG,
  pitchRateDeg: PITCH_RATE_DEG,
  turnRateRefDeg: TURN_RATE_REF_DEG,
  flapStall: FLAP_STALL,
  gravity: GRAVITY,
  airDensity: AIR_DENSITY,
  throttleExponent: THROTTLE_EXPONENT,
  liftAtZeroAoa: LIFT_AT_ZERO_AOA,
  liftCurveSlope: LIFT_CURVE_SLOPE,
  flapClmax: FLAP_CLMAX,
  flapLiftIncrement: FLAP_LIFT_INCREMENT,
  flapDragIncrement: FLAP_DRAG_INCREMENT,
  parasiteDrag: PARASITE_DRAG,
  inducedDragFactor: INDUCED_DRAG_FACTOR,
  stallAoaDeg: STALL_AOA_DEG,
  authorityFloor: AUTHORITY_FLOOR,
  authorityRefSpeed: AUTHORITY_REF_SPEED,
  spoolTimeS: SPOOL_TIME_S,
  turnBoost: TURN_BOOST,
  yawRateDeg: YAW_RATE_DEG,
  brakeDecel: BRAKE_DECEL,
  rollingFriction: ROLLING_FRICTION,
  grassFriction: GRASS_FRICTION,
};

export const FUEL_TUNING = {
  tank: FUEL_TANK,
  burnIdle: BURN_IDLE,
  burnFull: BURN_FULL,
  low: FUEL_LOW,
  critical: FUEL_CRITICAL,
  refuelTimeS: REFUEL_TIME,
  repairTimeS: REPAIR_TIME,
};

export const DAMAGE_TUNING = {
  hardLanding: DMG_HARD_LANDING,
  terrain: DMG_TERRAIN,
  building: DMG_BUILDING,
  overrun: DMG_OVERRUN,
  grassPerS: DMG_GRASS_PER_S,
  overspeedPerS: DMG_OVERSPEED_PER_S,
  repairTimeS: REPAIR_TIME,
  bands: DAMAGE_BANDS,
  wreckSinkBias: WRECK_SINK_BIAS,
  overspeedSustainS: OVERSPEED_SUSTAIN_S,
  terrainStrikeSpeed: TERRAIN_STRIKE_SPEED,
  terrainCrashSpeed: TERRAIN_CRASH_SPEED,
  buildingStrikeSpeed: BUILDING_STRIKE_SPEED,
  buildingCrashSpeed: BUILDING_CRASH_SPEED,
  overrunSpeed: OVERRUN_SPEED,
  grassDamageSpeed: GRASS_DAMAGE_SPEED,
};

export const SCORING = {
  ringPoints: RING_POINTS,
  ringCentreBonus: RING_CENTRE_BONUS,
  dropBase: DROP_BASE,
  dropBonus: DROP_BONUS,
  deliveryUnload: DELIVERY_UNLOAD,
  deliveryReturn: DELIVERY_RETURN,
  deliveryDivert: DELIVERY_DIVERT,
  landingBonusMax: LANDING_BONUS_MAX,
  homeBonus: HOME_BONUS,
  fuelBonusPerPct: FUEL_BONUS_PER_PCT,
  damagePenaltyPerPct: DAMAGE_PENALTY_PER_PCT,
  timeBonusPerS: TIME_BONUS_PER_S,
  timeBonusCap: TIME_BONUS_CAP,
  goAroundPenalty: GO_AROUND_PENALTY,
  engineOutPenalty: ENGINE_OUT_PENALTY,
  medalFractions: MEDAL_FRACTIONS,
};

// ---------------------------------------------------------------------------
// World layout (design.md section 5.2). Positions are plain {x, z} metres;
// world.js resolves ground height through its height function.
// ---------------------------------------------------------------------------

export const ISLANDS = [
  { name: "Aurora", centre: { x: 0, z: 0 }, radius: 900, peak: 60 },
  { name: "Brine Cay", centre: { x: 2800, z: -1600 }, radius: 650, peak: 45 },
  { name: "Gull Rock", centre: { x: -2400, z: -2200 }, radius: 500, peak: 80 },
  { name: "Lantern Isle", centre: { x: 1800, z: 2600 }, radius: 550, peak: 55 },
  { name: "Widow's Reef", centre: { x: -3200, z: 1800 }, radius: 400, peak: 35 },
  { name: "North Twin", centre: { x: 3800, z: 2200 }, radius: 350, peak: 50 },
  { name: "South Twin", centre: { x: 4400, z: 2900 }, radius: 350, peak: 50 },
  { name: "Signal Hill", centre: { x: -800, z: 3600 }, radius: 600, peak: 120 },
];

// Runway strips (design.md section 5.3). headingDeg is the runway direction;
// Twin Strip sits on North Twin and is the Tier-3 short-strip challenge.
export const STRIPS = [
  { id: "aurora", name: "Aurora Field", position: { x: 0, z: 0 }, headingDeg: 90, length: 350, width: STRIP_WIDTH },
  { id: "brine", name: "Brine Strip", position: { x: 2800, z: -1600 }, headingDeg: 45, length: 300, width: STRIP_WIDTH },
  { id: "gull", name: "Gull Strip", position: { x: -2400, z: -2200 }, headingDeg: 135, length: 300, width: STRIP_WIDTH },
  { id: "lantern", name: "Lantern Strip", position: { x: 1800, z: 2600 }, headingDeg: 0, length: 300, width: STRIP_WIDTH },
  { id: "twin", name: "Twin Strip", position: { x: 3800, z: 2200 }, headingDeg: 90, length: 220, width: STRIP_WIDTH },
];

// Difficulty tiers (design.md section 2.5). missions.js may override per sortie.
export const TIERS = [
  {
    tier: 1, name: "Calm Dawn",
    windMin: 0, windMax: 2, gust: 0, fogM: 0, cloudDeckM: 0,
    ringRadius: 12, ringCount: 8, dropRadius: 25, parcels: 3,
    deliveryKm: 4, startFuel: 1.0,
  },
  {
    tier: 2, name: "Fresh Breeze",
    windMin: 3, windMax: 5, gust: 2, fogM: 3000, cloudDeckM: 0,
    ringRadius: 10, ringCount: 10, dropRadius: 20, parcels: 4,
    deliveryKm: 6, startFuel: 1.0,
  },
  {
    tier: 3, name: "Squall Line",
    windMin: 6, windMax: 9, gust: 4, fogM: 1800, cloudDeckM: 400,
    ringRadius: 8, ringCount: 12, dropRadius: 15, parcels: 5,
    deliveryKm: 8, startFuel: 0.85,
  },
];
