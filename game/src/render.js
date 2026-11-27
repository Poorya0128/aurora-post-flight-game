// render.js — renderer, dawn sky, lights, fog, clouds, cameras (A7).
// Appearance directed by A8 (ui_spec.md §3 palette, §4b camera brief).
// Exports: createRenderer(canvas), buildSky(scene), updateCamera(camera, plane, mode, dt[, world]),
//          updateSky(scene, plane, dt) — cloud drift + shadow-frustum follow (called by main.js).

import * as THREE from 'three';
import { STRIPS } from './config.js';
import { AIRCRAFT_LAYOUT } from './aircraft.js';
import { linkCamera } from './camera-link.js';
import { linkSun } from './camera-link.js';
// VD6-SHADOW: fake-AO contact grounding + aircraft ground blob. Lazy-
// built from updateSky (first frame with a plane pose) so main.js and
// the flight logic stay untouched.
import { buildContactShadows, updateContactShadows, groundHeightAt } from './contact-shadow.js';
import { buildVolumetricClouds, updateVolumetricClouds } from './clouds.js'; // VD6-CLOUDS hook
import { enhanceSky, updateSkyExtras } from './sky.js'; // VD6-SKY hook (sky.js owns the sunset pass)
import { applyLighting, updateLighting } from './lighting.js'; // VD6-LIGHT hook (V6-LIGHTING)

// ---- A8 palette (ui_spec.md §3.1/§3.2 — exact hexes, no ad-hoc colours) ----
const PALETTE = {
  skyZenith: 0x2b3a67,
  skyMid: 0x7a5c8f,
  skyHorizon: 0xff9e64,
  sunDisc: 0xffd166,
  sunLight: 0xffb27a,
  ambient: 0x4a5a7a,
  hemisphereSky: 0x7a5c8f,
  hemisphereGround: 0x123c5a,
  fog: 0xe8a07a,
  cloudLit: 0xffc4a3,
  cloudShadow: 0x5a4a6b,
};

// Dawn sun elevation, locked at 9 degrees (visual_spec §2.4 / VD-02):
// steeper than the 6-degree spec (terrain went black, D-02) and lower
// than the old 13 degrees (blew out near the disc). The 1.15 exposure
// in createRenderer is tuned to pair with this angle.
const SUN_ELEVATION_DEG = 9;
const SUN_ELEVATION_RAD = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG);
// Exported for contact-shadow.js (VD6-SHADOW): AO blobs elongate along
// this azimuth so fake grounding rakes the same way as real shadows.
export const SUN_DIRECTION = new THREE.Vector3(
  Math.cos(SUN_ELEVATION_RAD), // east (+X)
  Math.sin(SUN_ELEVATION_RAD),
  0.18, // slight southward tilt so shadows rake across the home strip
).normalize();

// Camera constants (ui_spec §4b, framing per visual_spec §6 / VD-04, VD-07).
// The chase view sits off the left-rear quarter instead of dead astern:
// from straight behind, the wing filled the frame and the fuselage read
// small. This lower side offset shows nose, prop disc, struts and gear
// in silhouette at roughly 40-50% of frame height. Smoothing and the
// bank cap are untouched — the camera still never fights the pilot.
const CHASE_SIDE_M = -2.0; // metres left of the centreline
const CHASE_RISE_M = 1.8; // metres above the aircraft origin
const CHASE_TRAIL_M = 8.4; // metres behind the aircraft origin
const CHASE_OFFSET = new THREE.Vector3(CHASE_SIDE_M, CHASE_RISE_M, CHASE_TRAIL_M);
const CHASE_LOOK_AHEAD = 12; // metres ahead of the nose
const CHASE_FOV = 62;
const CHASE_FOV_KICK_MAX = 4; // extra degrees at high speed
const CHASE_FOV_KICK_SPEED = 56.6; // m/s ≈ 110 kt
const COCKPIT_FOV = 68;
const TOWER_FOV = 50; // locked for the tower view (VD-04); shots.js uses the same value
// Pilot eye point comes from aircraft.js (D-06) so the lit panel fills the
// lower frame with the horizon over the glareshield — never hard-code it here.
// VD-08 routed fix (render.js only): the eye sits a touch higher and
// further back than the raw layout point, so the placard and checklist
// bottoms clear the frame bottom by at least 24 px at 1280x720 (they
// clipped at the D-06 point after the panel shrink). Panel geometry
// itself is unchanged.
// V6 fix (VD6-04/VD6-15, render share): eye raised a further +0.05 m so
// the glareshield drops in frame and more runway shows over it on final
// (audit-shot2 runway was a sliver); raising the eye only increases the
// VD-08 bottom clearance. Paired with the gentler head tilt below.
// User order 2026-11-27: eye below wing underside so wings read
// naturally (shaded underside, not white slabs); overhead panel moved
// up/back in cockpit-glass.js. Sling rebuild 2026-11-27: eye point is
// CENTRE (x=0). Camera fix 2026-11-27: layout (0, 0.82, 0.47) + this
// offset -> effective eye (0, 0.74, 0.55): eased back/down so stick +
// console compose the frame bottom, panel top ~60% from top (lower
// ~40%), runway dead-centre ahead, eye still below wing underside ~0.795.
const COCKPIT_HEAD_OFFSET = AIRCRAFT_LAYOUT.cockpitEyePoint.clone();
COCKPIT_HEAD_OFFSET.y += -0.08;
COCKPIT_HEAD_OFFSET.z += 0.08;
// Fixed tower vantage (VD-04): low and close to the climb-out end of
// the home strip, so a departing aircraft fills 35-45% of the frame
// (the old high perch 24 m abeam left it near 10%). Offsets are in
// strip-local metres: ahead along the runway, then sideways — negative
// sideways is the north edge, opposite the buildings.
const TOWER_AHEAD_M = 30;
const TOWER_SIDE_M = -13;
const TOWER_CLEARANCE_M = 5; // height over the strip surface
const CAMERA_MIN_GROUND_CLEARANCE = 2.5; // metres above terrain (design.md §4.3)
const CAMERA_BLEND_SECONDS = 0.35;
const SHADOW_MAP_RES = 4096; // shadow map edge length in texels

// Reused scratch objects — no per-frame allocation in the camera path.
const _desiredPosition = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _desiredQuaternion = new THREE.Quaternion();
const _lookMatrix = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _planeQuaternion = new THREE.Quaternion();
const _yawPitchQuaternion = new THREE.Quaternion();

// Smoothed camera state, shared across modes so switches blend instead of cutting.
const cameraState = {
  initialised: false,
  mode: 'chase',
  blend: 1,
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  fov: CHASE_FOV,
  towerPosition: new THREE.Vector3(0, 18, 0),
};

// Deterministic pseudo-random generator (fixed seed) so clouds sit in the
// same places every run — screenshots stay reproducible (design.md §5.6).
function makeSeededRandom(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15; // locked with the 9-degree sun (VD-02); 1.3 blew out
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // D-135: the 2048² shadow map re-renders only when the aircraft has
  // actually moved/turned (updateSky sets needsUpdate); parked and menu
  // frames reuse the last map instead of paying ~115 draws every frame.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.userData.renderer = renderer; // updateSky flags shadow updates (D-135)
  scene.fog = new THREE.Fog(PALETTE.fog, 800, 6000); // warm dawn haze (ui_spec §3.2)

  const camera = new THREE.PerspectiveCamera(CHASE_FOV, 1, 0.1, 30000);
  camera.position.set(0, 30, 60);
  // Share the live camera and sun vector with the HUD layer: the target
  // bracket projects through this camera, the lens flare tracks the sun.
  linkCamera(camera);
  linkSun(SUN_DIRECTION);

  const applySize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  applySize();
  window.addEventListener('resize', applySize);

  // Park the tower camera at the fixed vantage by the home strip
  // (VD-04 framing; still a fixed vantage per design.md §4.3).
  const homeStrip = Array.isArray(STRIPS) && STRIPS.length > 0 ? STRIPS[0] : null;
  if (homeStrip && homeStrip.position) {
    const stripHeading = THREE.MathUtils.degToRad(homeStrip.headingDeg || 0);
    const alongX = Math.sin(stripHeading);
    const alongZ = -Math.cos(stripHeading);
    const acrossX = Math.cos(stripHeading);
    const acrossZ = Math.sin(stripHeading);
    const towerX = homeStrip.position.x + alongX * TOWER_AHEAD_M + acrossX * TOWER_SIDE_M;
    const towerZ = homeStrip.position.z + alongZ * TOWER_AHEAD_M + acrossZ * TOWER_SIDE_M;
    cameraState.towerPosition.set(towerX, TOWER_CLEARANCE_M, towerZ);
  }

  return { renderer, scene, camera };
}

// ---------------------------------------------------------------------------
// Sky, sun, lights, clouds
// ---------------------------------------------------------------------------

function buildSkyDome() {
  const skyGeometry = new THREE.SphereGeometry(14000, 32, 16);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenithColour: { value: new THREE.Color(PALETTE.skyZenith) },
      midColour: { value: new THREE.Color(PALETTE.skyMid) },
      horizonColour: { value: new THREE.Color(PALETTE.skyHorizon) },
      sunColour: { value: new THREE.Color(PALETTE.sunDisc) },
      sunDirection: { value: SUN_DIRECTION.clone() },
    },
    vertexShader: [
      'varying vec3 vWorldDirection;',
      'void main() {',
      '  vWorldDirection = normalize(position);',
      '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
      '  gl_Position = projectionMatrix * mvPosition;',
      '  gl_Position.z = gl_Position.w;', // pin to far plane
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 zenithColour;',
      'uniform vec3 midColour;',
      'uniform vec3 horizonColour;',
      'uniform vec3 sunColour;',
      'uniform vec3 sunDirection;',
      'varying vec3 vWorldDirection;',
      'void main() {',
      '  float height = clamp(vWorldDirection.y, -1.0, 1.0);',
      '  vec3 colour = mix(horizonColour, midColour, smoothstep(0.0, 0.22, height));',
      '  colour = mix(colour, zenithColour, smoothstep(0.18, 0.65, height));',
      '  colour = mix(colour, horizonColour * 0.55, smoothstep(0.0, -0.25, height));',
      '  float sunAmount = max(dot(normalize(vWorldDirection), normalize(sunDirection)), 0.0);',
      // VD6-LOOK: disc 1.15 → 1.35, glow 0.22 → 0.30 — the reference
      // sun sits on the horizon as a bright disc in a wide warm halo.
      '  colour += sunColour * pow(sunAmount, 220.0) * 1.35;', // tight sun disc
      '  colour += sunColour * pow(sunAmount, 6.0) * 0.30;', // wide dawn halo
      '  gl_FragColor = vec4(colour, 1.0);',
      '}',
    ].join('\n'),
  });
  const skyDome = new THREE.Mesh(skyGeometry, skyMaterial);
  skyDome.name = 'dawnSkyDome';
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -10;
  return skyDome;
}

function buildSunSprite() {
  // Soft additive glow around the shader disc, drawn on a small canvas.
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255, 225, 160, 0.95)');
  gradient.addColorStop(0.25, 'rgba(255, 209, 102, 0.55)');
  gradient.addColorStop(1, 'rgba(255, 158, 100, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  // Halo strength: strong enough to read as dawn glow around the disc
  // without bleaching the sky at judge size.
  material.opacity = 0.9;
  const sprite = new THREE.Sprite(material);
  sprite.name = 'sunGlow';
  sprite.scale.set(2100, 2100, 1); // broad halo; 2600 washed out the runway and sea
  sprite.position.copy(SUN_DIRECTION).multiplyScalar(12000);
  return sprite;
}

// The old instanced-sphere cloud field that used to live here is
// retired: buildSky now builds the volumetric clouds from
// clouds.js, and nothing referenced the sphere field any more.

export function buildSky(scene) {
  const skyDome = buildSkyDome();
  scene.add(skyDome);
  scene.add(buildSunSprite());

  // Warm key light, low in the east, with one shadow map whose tight
  // frustum follows the aircraft (ui_spec §4b) — moved in updateSky().
  // The 4096 map (up from 2048) halves the texel size, so airframe,
  // strut and gear shadows land crisp on the strip.
  // VD6-SHADOW (shadow-camera only; intensity/colour stay with the
  // lighting balance): the fixed ±160 m frustum gave 7.8 cm texels —
  // soft everywhere — and normalBias 1.5 detached shadows from prop
  // bases (peter-panning, "floating" crates/hangar). Now: frustum
  // scales with height above ground (±55 m parked → ±150 m at altitude,
  // applied in updateSky), normalBias 0.55 for tight contact, bias
  // −0.0003, and near/far tightened to the light's 420 m standoff for
  // depth precision. PCFSoft ignores shadow.radius, so softness comes
  // from texel size (frustum ÷ 4096), not a radius knob. The aircraft's
  // readable ground shadow at altitude is contact-shadow.js's blob —
  // at a 9° sun the true shadow lands AGL×6.3 m west, off-frame.
  // (VD6-LIGHT's applyLighting re-tunes bias/normalBias/extent right
  // after this block; updateSky then owns the frustum per frame.)
  const sunLight = new THREE.DirectionalLight(PALETTE.sunLight, 3); // VD-02 balance; was 3.4
  sunLight.name = 'dawnSunLight';
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(SHADOW_MAP_RES, SHADOW_MAP_RES);
  sunLight.shadow.camera.left = -55;
  sunLight.shadow.camera.right = 55;
  sunLight.shadow.camera.top = 55;
  sunLight.shadow.camera.bottom = -55;
  sunLight.shadow.camera.near = 150;
  sunLight.shadow.camera.far = 700;
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.55;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Fill balance (VD-09/VD-10): hemisphere 1.2 and ambient 0.45, down
  // from 2.0/0.9 — cream paint stays cream instead of lilac, off-lane
  // sea stays teal, and the flat wash that fed the sun blowout is gone.
  const hemisphereLight = new THREE.HemisphereLight(PALETTE.hemisphereSky, PALETTE.hemisphereGround, 1.2);
  hemisphereLight.name = 'dawnHemisphereLight';
  scene.add(hemisphereLight);

  const ambientLight = new THREE.AmbientLight(PALETTE.ambient);
  ambientLight.intensity = 0.45;
  ambientLight.name = 'dawnAmbientLight';
  scene.add(ambientLight);

  // VD6-CLOUDS hook: volumetric-look puffy clouds (clouds.js) replace
  // the old two-tone sphere field, which has been removed.
  const cloudGroup = buildVolumetricClouds();
  scene.add(cloudGroup);

  scene.userData.sky = { skyDome, sunLight, cloudGroup };
  // VD6-LIGHT (V6-LIGHTING): realism light rig — warm key / cool fill /
  // warm bounce, shadow tuning, fog haze, ACES exposure, sunset IBL.
  applyLighting(scene.userData.renderer, scene);
  enhanceSky(scene, SUN_DIRECTION); // VD6-SKY: sunset gradient + sun/haze/rays (sky.js; after lighting so fog colour matches the new horizon)
  return scene.userData.sky;
}

// VD6-SHADOW: shadow-frustum follow state. Extent scales with height
// above ground; the centre is texel-snapped in light space so shadow
// edges don't swim as the aircraft moves. (VD6-LIGHT's applyLighting
// sets bias/extent once at build; this per-frame block owns the
// frustum from the first frame on, ending at their ±150 / 0.4 values
// at altitude.)
const SHADOW_EXTENT_MIN = 55; // parked / taxi: 2.7 cm texels at 4096²
const SHADOW_EXTENT_MAX = 150; // at altitude: covers the airfield below
const SHADOW_LIGHT_DISTANCE = 420;
const _shadowCentre = new THREE.Vector3();
const _shadowRight = new THREE.Vector3()
  .crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIRECTION).normalize();
const _shadowUp = new THREE.Vector3()
  .crossVectors(SUN_DIRECTION, _shadowRight).normalize();

// Per-frame sky upkeep: keep the shadow frustum centred on the aircraft and
// drift the clouds. Called by main.js each render frame.
export function updateSky(scene, plane, dt) {
  const sky = scene.userData.sky;
  if (!sky) return;
  updateLighting(scene, plane); // VD6-LIGHT: fill/bounce follow + material polish

  if (plane && plane.position) {
    const sunLight = sky.sunLight;

    // VD6-SHADOW: altitude-scaled frustum. Low = tight + crisp gear and
    // prop shadows on the strip; high = wide enough to keep the
    // airfield's buildings/trees casting under the chase camera.
    // normalBias scales with texel size so contact stays tight when
    // parked (0.15 at ±55 m) and matches VD6-LIGHT's 0.4 at ±150 m.
    const agl = Math.max(plane.position.y - groundHeightAt(plane.position.x, plane.position.z), 0);
    const targetExtent = THREE.MathUtils.clamp(
      SHADOW_EXTENT_MIN + agl * 0.55, SHADOW_EXTENT_MIN, SHADOW_EXTENT_MAX,
    );
    if (sky.shadowExtent === undefined) sky.shadowExtent = targetExtent;
    sky.shadowExtent += (targetExtent - sky.shadowExtent) * (1 - Math.exp(-dt * 2));
    let frustumChanged = false;
    if (Math.abs(sky.shadowExtent - (sky.shadowExtentApplied || 0)) > 0.5) {
      const extent = sky.shadowExtent;
      sunLight.shadow.camera.left = -extent;
      sunLight.shadow.camera.right = extent;
      sunLight.shadow.camera.top = extent;
      sunLight.shadow.camera.bottom = -extent;
      sunLight.shadow.camera.updateProjectionMatrix();
      sunLight.shadow.normalBias = THREE.MathUtils.clamp(extent * 0.0027, 0.15, 0.4);
      sky.shadowExtentApplied = extent;
      frustumChanged = true;
    }

    // Texel-snap the frustum centre: quantise the aircraft position in
    // light space to whole shadow texels so edges stay locked to the
    // world instead of crawling.
    const texel = (sky.shadowExtent * 2) / SHADOW_MAP_RES;
    _shadowCentre.copy(plane.position);
    const alongRight = _shadowCentre.dot(_shadowRight);
    const alongUp = _shadowCentre.dot(_shadowUp);
    _shadowCentre
      .addScaledVector(_shadowRight, Math.round(alongRight / texel) * texel - alongRight)
      .addScaledVector(_shadowUp, Math.round(alongUp / texel) * texel - alongUp);
    sunLight.position.copy(_shadowCentre).addScaledVector(SUN_DIRECTION, SHADOW_LIGHT_DISTANCE);
    sunLight.target.position.copy(_shadowCentre);
    sunLight.target.updateMatrixWorld();
    if (frustumChanged && scene.userData.renderer) {
      scene.userData.renderer.shadowMap.needsUpdate = true;
    }

    // VD6-SHADOW: contact grounding (fake-AO blobs + aircraft ground
    // blob). Built once, on the first frame the world + plane exist.
    // Guarded: grounding is an enhancement, never a frame-loop blocker.
    if (!scene.userData.contactShadows && !scene.userData.contactShadowsTried) {
      scene.userData.contactShadowsTried = true;
      try {
        scene.userData.contactShadows = buildContactShadows(scene, SUN_DIRECTION);
      } catch (error) {
        scene.userData.contactShadows = null;
      }
    }
    updateContactShadows(scene.userData.contactShadows, plane);
    // Sky dome and sun glow ride along so the horizon never gets closer.
    sky.skyDome.position.copy(plane.position);
    updateSkyExtras(scene, plane); // VD6-SKY: sun/haze/ray extras ride along too (sky.js)

    // D-135: re-render the shadow map only when the aircraft has moved
    // (>0.5 m) or turned (>~0.6°) since the last shadow render. Parked
    // and menu frames reuse the map; flight frames refresh as before.
    const renderer = scene.userData.renderer;
    if (renderer) {
      if (!sky.shadowPose) {
        sky.shadowPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
        sky.shadowPose.position.copy(plane.position);
        if (plane.quaternion) sky.shadowPose.quaternion.copy(plane.quaternion);
        renderer.shadowMap.needsUpdate = true;
      } else {
        const moved = sky.shadowPose.position.distanceToSquared(plane.position) > 0.25;
        const turned = plane.quaternion
          && sky.shadowPose.quaternion.angleTo(plane.quaternion) > 0.01;
        if (moved || turned) {
          sky.shadowPose.position.copy(plane.position);
          if (plane.quaternion) sky.shadowPose.quaternion.copy(plane.quaternion);
          renderer.shadowMap.needsUpdate = true;
        }
      }
    }
  }

  // VD6-CLOUDS hook: drift lives in the cloud shaders (time uniform);
  // the old per-frame instance-matrix rewrite is retired with the field.
  updateVolumetricClouds(sky.cloudGroup, dt);
}

// ---------------------------------------------------------------------------
// Cameras — chase / cockpit / tower. The camera never fights the pilot:
// chase lags smoothly, follows only 35% of bank, and never clips terrain.
// ---------------------------------------------------------------------------

function getPlaneRollRadians(plane) {
  if (typeof plane.rollDeg === 'number') return THREE.MathUtils.degToRad(plane.rollDeg);
  _euler.setFromQuaternion(plane.quaternion, 'YXZ');
  return _euler.z;
}

function computeChaseTransform(plane, world) {
  _desiredPosition.copy(CHASE_OFFSET).applyQuaternion(plane.quaternion).add(plane.position);

  // Keep the camera off the ground (design.md §4.3).
  if (world && typeof world.heightAt === 'function') {
    const groundHeight = world.heightAt(_desiredPosition.x, _desiredPosition.z);
    _desiredPosition.y = Math.max(_desiredPosition.y, groundHeight + CAMERA_MIN_GROUND_CLEARANCE);
  }

  _forward.set(0, 0, -1).applyQuaternion(plane.quaternion);
  _lookTarget.copy(plane.position).addScaledVector(_forward, CHASE_LOOK_AHEAD);

  // Up vector follows only 35% of the aircraft's bank so the horizon stays
  // readable in turns (ui_spec §4b).
  const partialRoll = getPlaneRollRadians(plane) * 0.35;
  _euler.setFromQuaternion(plane.quaternion, 'YXZ');
  _euler.z = partialRoll;
  _yawPitchQuaternion.setFromEuler(_euler);
  _up.set(0, 1, 0).applyQuaternion(_yawPitchQuaternion);

  _lookMatrix.lookAt(_desiredPosition, _lookTarget, _up);
  _desiredQuaternion.setFromRotationMatrix(_lookMatrix);
}

function computeCockpitTransform(plane, elapsedSeconds) {
  _desiredPosition.copy(COCKPIT_HEAD_OFFSET).applyQuaternion(plane.quaternion).add(plane.position);

  // Tiny airframe vibration scaled by throttle — amplitude ≤ 4 mm (ui_spec §4b).
  const vibration = 0.004 * (plane.throttle || 0);
  _desiredPosition.y += Math.sin(elapsedSeconds * 47) * vibration;

  // Head looks straight ahead through the windscreen, tilted down a
  // touch so the panel sits in the lower frame (ui_spec §4a). The tilt
  // pairs with the raised, eased-back eye point above so the placard
  // and checklist bottoms clear the frame bottom (VD-08, measured on
  // stills); panel geometry itself is untouched.
  _planeQuaternion.copy(plane.quaternion);
  _euler.setFromQuaternion(_planeQuaternion, 'YXZ');
  // V6 fix (VD6-04): 0.052 → 0.04 rad — less downward tilt lifts the
  // horizon/runway over the glareshield; panel bottoms keep VD-08
  // clearance because the eye point rose with it (see above).
  // Camera fix 2026-11-27: 0.04 → 0.055 rad pairs with the back/down
  // eye move (effective eye (0, 0.74, 0.55)) — frame bottom reaches
  // ~37.2 deg depression so the stick grip (top ~21% above frame
  // bottom) and console front edge (~11.5%) compose the bottom of
  // frame; panel bottoms still clear by ~84 px at 720p.
  // M8 pass 2026-11-27 (after B1 cowling drop): eased back to
  // 0.048 rad — lifts the runway/sky sector a touch and drops the
  // panel+stick ~1% in frame without hiding any geometry; eye point
  // unchanged (audit: do not move the camera to hide defects).
  _euler.x -= 0.048;
  _desiredQuaternion.setFromEuler(_euler);
}

function computeTowerTransform(plane, world) {
  // Settle the tower height onto the terrain once (strip elevation
  // plus the low vantage clearance).
  if (world && typeof world.heightAt === 'function' && !cameraState.towerHeightSet) {
    const stripGroundY = world.heightAt(cameraState.towerPosition.x, cameraState.towerPosition.z);
    cameraState.towerPosition.y = stripGroundY + TOWER_CLEARANCE_M;
    cameraState.towerHeightSet = true;
  }
  _desiredPosition.copy(cameraState.towerPosition);
  _lookTarget.copy(plane.position);
  _up.set(0, 1, 0);
  _lookMatrix.lookAt(_desiredPosition, _lookTarget, _up);
  _desiredQuaternion.setFromRotationMatrix(_lookMatrix);
}

export function updateCamera(camera, plane, mode, dt, world) {
  if (!plane || !plane.position || !plane.quaternion) return;

  const clampedDt = Math.min(Math.max(dt, 0), 0.1);
  const elapsedSeconds = performance.now() / 1000;

  let targetFov = CHASE_FOV;
  if (mode === 'cockpit') {
    computeCockpitTransform(plane, elapsedSeconds);
    targetFov = COCKPIT_FOV;
  } else if (mode === 'tower') {
    computeTowerTransform(plane, world);
    targetFov = TOWER_FOV;
  } else {
    computeChaseTransform(plane, world);
    // Gentle FOV kick with speed — lerped, never a snap (ui_spec §4b).
    const speed = typeof plane.airspeed === 'number' ? plane.airspeed : 0;
    const kickFraction = THREE.MathUtils.clamp((speed - CHASE_FOV_KICK_SPEED) / 20, 0, 1);
    targetFov = CHASE_FOV + CHASE_FOV_KICK_MAX * kickFraction;
  }

  if (!cameraState.initialised) {
    cameraState.position.copy(_desiredPosition);
    cameraState.quaternion.copy(_desiredQuaternion);
    cameraState.fov = targetFov;
    cameraState.initialised = true;
    cameraState.mode = mode;
  }

  // Mode switch: blend over 0.35 s instead of a hard cut (ui_spec §4b).
  if (mode !== cameraState.mode) {
    cameraState.mode = mode;
    cameraState.blend = 0;
  }
  cameraState.blend = Math.min(1, cameraState.blend + clampedDt / CAMERA_BLEND_SECONDS);

  if (mode === 'cockpit') {
    // Cockpit is locked to the airframe — no lag, or the panel swims.
    cameraState.position.copy(_desiredPosition);
    cameraState.quaternion.copy(_desiredQuaternion);
  } else {
    const positionLerp = 1 - Math.exp(-clampedDt * 4.5);
    const orientationSlerp = 1 - Math.exp(-clampedDt * (mode === 'tower' ? 3 : 6));
    cameraState.position.lerp(_desiredPosition, positionLerp);
    cameraState.quaternion.slerp(_desiredQuaternion, orientationSlerp);
  }

  camera.position.copy(cameraState.position);
  camera.quaternion.copy(cameraState.quaternion);

  cameraState.fov += (targetFov - cameraState.fov) * (1 - Math.exp(-clampedDt * 2.5));
  if (Math.abs(camera.fov - cameraState.fov) > 0.01) {
    camera.fov = cameraState.fov;
    camera.updateProjectionMatrix();
  }
}

// Menu backdrop: slow orbit around the parked plane on the home strip
// (design.md §1.1). Framing tightened (was radius 140 / height 42 around
// the tower offset, which lost the plane and let dark silhouettes intrude
// at the top edge): orbit the strip centre itself, closer and lower, so
// plane + runway + airfield buildings compose cleanly at every angle.
const MENU_ORBIT_CENTRE = (() => {
  const homeStrip = Array.isArray(STRIPS) && STRIPS.length > 0 ? STRIPS[0] : null;
  if (homeStrip && homeStrip.position) {
    // Offset a little down the runway from the parked plane so the plane
    // orbits beside the title screen's button column instead of behind it.
    const headingRad = THREE.MathUtils.degToRad(homeStrip.headingDeg || 0);
    return new THREE.Vector3(
      homeStrip.position.x + Math.sin(headingRad) * 12,
      0,
      homeStrip.position.z - Math.cos(headingRad) * 12,
    );
  }
  return new THREE.Vector3(0, 0, 0);
})();

export function updateMenuCamera(camera, elapsedSeconds, world) {
  const orbitRadius = 50;
  // Heights are terrain-relative: the home strip sits well above sea level,
  // so absolute heights would bury the camera in the island.
  const groundY = world && typeof world.heightAt === 'function'
    ? world.heightAt(MENU_ORBIT_CENTRE.x, MENU_ORBIT_CENTRE.z) : 0;
  const angle = elapsedSeconds * 0.05;
  camera.position.set(
    MENU_ORBIT_CENTRE.x + Math.cos(angle) * orbitRadius,
    groundY + 16,
    MENU_ORBIT_CENTRE.z + Math.sin(angle) * orbitRadius,
  );
  _lookTarget.set(MENU_ORBIT_CENTRE.x, groundY + 3, MENU_ORBIT_CENTRE.z);
  camera.lookAt(_lookTarget);
  if (camera.fov !== CHASE_FOV) {
    camera.fov = CHASE_FOV;
    camera.updateProjectionMatrix();
  }
  cameraState.initialised = false; // next flight camera starts clean
}
