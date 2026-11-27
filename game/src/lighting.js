// lighting.js — VD6-LIGHT realism lighting pass (V6-LIGHTING, 2026-11-26).
// User mandate: strengthen lighting as much as possible, elements as
// realistic as possible (photoreal-leaning stylised, SwiftShader budget).
// render.js stays owned by V6-WORLD-LOOK; this module hooks in with two
// calls (applyLighting at the end of buildSky, updateLighting inside
// updateSky) and owns only the light rig, fog, tone-mapping exposure,
// shadow tuning, a procedural sunset environment map, and one deferred
// material polish pass. No logic, heights, or geometry are touched.
// Extra cost: 2 shadowless directional lights + 1 PMREM generated once
// at boot. Zero new draw calls, zero new shadow casters. Plus 2
// shadowless point lights parented to the cockpit group (interior
// fill, cockpit view only — invisible and costless in chase/tower).

import * as THREE from 'three';

// Warm golden-hour key / cool sky fill balance, matched to the user's
// chase + tower references (deep purple zenith, orange horizon, strong
// warm raking sun, cool readable shadow sides) and the cockpit
// reference (warm sun across the panel, hazy layered distance).
const LIGHTING = {
  exposure: 1.28, // ACES (render.js) was 1.15 — references sit brighter/golden
  sunColor: 0xff9e57, // deeper golden-hour orange (was 0xffb27a)
  sunIntensity: 3.4, // was 3.0 — stronger raking key, crisper modelling
  hemiSky: 0x8a7bc8, // lavender zenith bounce (was 0x7a5c8f)
  hemiGround: 0x2e4a52, // teal sea/terrain bounce (was 0x123c5a)
  hemiIntensity: 0.85, // was 1.2 — less wash, deeper readable shadows
  ambientColor: 0x3d4a6b, // cooler ambient (was 0x4a5a7a)
  ambientIntensity: 0.22, // was 0.45 — ambient flattens; fill lights do the work
  fillColor: 0x6b8fd4, // cool western sky fill, opposite the sun
  fillIntensity: 0.55,
  bounceColor: 0xffb27a, // warm ground/sea bounce from below the horizon
  bounceIntensity: 0.3,
  fogColor: 0xe08a5e, // warm haze between sky horizon and mid (was 0xe8a07a)
  fogNear: 550, // was 800 — aerial perspective starts sooner
  fogFar: 5200, // was 6000 — distant islands layer into haze like the refs
  shadowBias: -0.0003, // was -0.0004
  shadowNormalBias: 0.4, // was 1.5 — 1.5 m detached shadows (peter-panning);
  // 4096 map over a 300 m frustum = 7.3 cm texels, so 0.4 m (~5 texels)
  // still clears acne on faceted terrain while keeping contact shadows.
  shadowExtent: 150, // was 160 — slightly tighter frustum, crisper texels
  // Cockpit interior fill (cockpit view ONLY — see ensureInteriorLights).
  // Physical units (three r170): intensity is candela, so ~1.0 at the
  // 0.6–0.9 m distances inside the cabin lands ~1.3–1.8 effective —
  // a soft lift under the 3.4-intensity sun key, no blow-out. Colours
  // are warm-neutral (less orange than the sun) so grey trim reads
  // grey, not brown, while still matching the sunset reference photo.
  interiorDomeColor: 0xffe8cc, // MATFIX: slightly paler warm so cream/grey hold hue at sunset
  interiorDomeIntensity: 1.15, // m6 rebalance: interior UP (was 0.8) — roof position + decay 2.0 keeps the gradient, so trim/console model instead of sitting black; pale exteriors were darkened to compensate (B1/B2/M7)
  interiorDomeDistance: 3.2,
  interiorDomeDecay: 2.0, // MATFIX: faster falloff = readable shading falloff to floor
  interiorFootColor: 0xffc98f,
  interiorFootIntensity: 0.85, // m6: footwell UP (was 0.55) so pedals/carpet/nets model; tight distance keeps it off the MFDs (unlit anyway)
  interiorFootDistance: 2.4, // MATFIX: tighter reach, footwell-scoped
  interiorFootDecay: 2.0,
};

// Fill comes from the west-northwest sky (opposite the eastern sun) and
// a little above the horizon; bounce comes from below the aircraft,
// like sunlit sea/terrain reflecting up onto bellies and wing undersides.
const FILL_DIRECTION = new THREE.Vector3(-0.85, 0.35, -0.3).normalize();
const BOUNCE_DIRECTION = new THREE.Vector3(0.2, -1, 0.1).normalize();

// Procedural sunset equirect for image-based lighting: painted on a
// small canvas (no downloaded assets). Gives canopy glass, metal and
// painted skin real sky reflections — the single biggest realism win
// available without new geometry. Sun blob sits at the eastern horizon
// (+X maps to u=0.75 in Three's equirect convention for a canvas whose
// left edge faces -Z... the blob is wide and soft, so exact azimuth is
// forgiving; intensity is kept low on diffuse surfaces).
function buildSunsetEnvironment(renderer) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0.0, '#2b3a67'); // zenith
    gradient.addColorStop(0.38, '#7a5c8f'); // mid lavender
    gradient.addColorStop(0.5, '#ff9e64'); // horizon orange
    gradient.addColorStop(0.54, '#e88b4a'); // just below horizon
    gradient.addColorStop(0.62, '#123c5a'); // sea
    gradient.addColorStop(1.0, '#0a2438'); // deep sea / ground
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    // Sun glow + disc at the horizon (east). Drawn twice (wrapped) so
    // the seam never cuts the glow.
    for (const cx of [384, 384 - 512]) {
      const glow = ctx.createRadialGradient(cx, 128, 2, cx, 128, 90);
      glow.addColorStop(0, 'rgba(255,240,200,1)');
      glow.addColorStop(0.12, 'rgba(255,209,102,0.85)');
      glow.addColorStop(0.45, 'rgba(255,158,100,0.35)');
      glow.addColorStop(1, 'rgba(255,158,100,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(cx - 90, 38, 180, 180);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromEquirectangular(texture);
    pmrem.dispose();
    texture.dispose();
    return envRT.texture;
  } catch (error) {
    return null; // environment is an enhancement, never a boot blocker
  }
}

// Called once from render.js buildSky (after the base lights exist).
export function applyLighting(renderer, scene) {
  renderer.toneMappingExposure = LIGHTING.exposure;

  const sky = scene.userData.sky || {};
  const sunLight = sky.sunLight;
  if (sunLight) {
    sunLight.color.setHex(LIGHTING.sunColor);
    sunLight.intensity = LIGHTING.sunIntensity;
    sunLight.shadow.bias = LIGHTING.shadowBias;
    sunLight.shadow.normalBias = LIGHTING.shadowNormalBias;
    sunLight.shadow.radius = 2; // honoured by PCF; PCFSoft uses its own kernel
    const cam = sunLight.shadow.camera;
    cam.left = -LIGHTING.shadowExtent;
    cam.right = LIGHTING.shadowExtent;
    cam.top = LIGHTING.shadowExtent;
    cam.bottom = -LIGHTING.shadowExtent;
    cam.updateProjectionMatrix();
  }

  scene.traverse((object) => {
    if (object.isHemisphereLight) {
      object.color.setHex(LIGHTING.hemiSky);
      object.groundColor.setHex(LIGHTING.hemiGround);
      object.intensity = LIGHTING.hemiIntensity;
    } else if (object.isAmbientLight) {
      object.color.setHex(LIGHTING.ambientColor);
      object.intensity = LIGHTING.ambientIntensity;
    }
  });

  // Cool fill + warm bounce: shadowless, so they cost one lighting
  // evaluation each and no shadow-map renders.
  const fillLight = new THREE.DirectionalLight(LIGHTING.fillColor, LIGHTING.fillIntensity);
  fillLight.name = 'vd6CoolFillLight';
  fillLight.castShadow = false;
  scene.add(fillLight);
  scene.add(fillLight.target);

  const bounceLight = new THREE.DirectionalLight(LIGHTING.bounceColor, LIGHTING.bounceIntensity);
  bounceLight.name = 'vd6WarmBounceLight';
  bounceLight.castShadow = false;
  scene.add(bounceLight);
  scene.add(bounceLight.target);

  if (scene.fog && scene.fog.isFog) {
    scene.fog.color.setHex(LIGHTING.fogColor);
    scene.fog.near = LIGHTING.fogNear;
    scene.fog.far = LIGHTING.fogFar;
  }

  // Per-material envMap (assigned in polishMaterials), NOT
  // scene.environment: scene-wide IBL compiles env sampling into every
  // standard material, including the terrain that fills most fragments
  // — needless SwiftShader cost. Only reflective surfaces get the map.
  const environment = buildSunsetEnvironment(renderer);

  scene.userData.lighting = {
    fillLight, bounceLight, environment, polished: false,
    interiorLights: null, interiorHost: null,
  };
  return scene.userData.lighting;
}

// Cockpit-only interior fill: two shadowless point lights parented to
// the 'aircraft-cockpit' group (built by aircraft.js, added to the
// scene by main.js, which toggles its visibility per camera mode).
// Because the lights are CHILDREN of that group, three.js skips them
// entirely in chase/tower views — zero exterior impact, no changes to
// main.js/render.js needed. Created lazily from updateLighting because
// the cockpit group does not exist yet when applyLighting runs (same
// reason polishMaterials is deferred). Positions are in aircraft
// space (eye ~(0,0.78,0.43), panel (0,0.22,-0.88), walls x=±0.62):
// the dome light sits just forward/below the eye so door cards,
// tunnel cheeks and the seat cushion catch soft grazing light; the
// footwell light lifts carpet, net pockets and lower door cards. The
// panel keeps its own light in aircraft.js — these only fill trim.
function ensureInteriorLights(scene) {
  const lighting = scene.userData.lighting;
  if (!lighting || lighting.interiorLights) return;
  const host = scene.getObjectByName('aircraft-cockpit');
  if (!host) return; // aircraft not built yet — retry next frame
  const dome = new THREE.PointLight(
    LIGHTING.interiorDomeColor, LIGHTING.interiorDomeIntensity,
    LIGHTING.interiorDomeDistance, LIGHTING.interiorDomeDecay,
  );
  dome.name = 'cockpitInteriorDomeLight';
  dome.position.set(0, 0.98, 0.28); // MATFIX: roof dome (was eye-level 0.62) — light falls down across seat/doors with gradient, trim keeps depth; still cockpit-group child only
  dome.castShadow = false;
  host.add(dome);
  const foot = new THREE.PointLight(
    LIGHTING.interiorFootColor, LIGHTING.interiorFootIntensity,
    LIGHTING.interiorFootDistance, LIGHTING.interiorFootDecay,
  );
  foot.name = 'cockpitInteriorFootLight';
  foot.position.set(0, -0.28, -0.55); // MATFIX: low/forward in footwell (was mid-cabin) — lifts pedals/carpet/nets, panel keeps its own rake; cockpit-group child only
  foot.castShadow = false;
  host.add(foot);
  lighting.interiorLights = [dome, foot];
  lighting.interiorHost = host;
}

// One deferred pass over every standard material in the built scene
// (world + aircraft exist by the first updateSky call): sky-reflection
// strength by surface type, plus a water sheen for the sea. Emissive
// colours/intensities (rings, lamps, gauges) are left exactly as their
// owners tuned them — only envMap + envMapIntensity are added.
function polishMaterials(scene) {
  const environment = scene.userData.lighting && scene.userData.lighting.environment;
  const seen = new Set();
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material || !material.isMeshStandardMaterial || seen.has(material)) continue;
      seen.add(material);
      // Terrain + merged vertex-coloured props: no envMap at all — they
      // cover most fragments and matte diffuse gains nothing from IBL.
      if (material.vertexColors && object.name !== 'sea-plane') continue;
      let intensity = null;
      if (object.name === 'sea-plane') {
        // Water: let the sunset environment reflect. Roughness 0.85 was
        // tuned for a world without IBL (VD-10); with the env map the
        // surface can carry a real sky sheen instead of flat navy.
        material.roughness = 0.45;
        intensity = 0.7;
      } else if (material.metalness >= 0.3) {
        intensity = 1.0; // metal, canopy glass, bezels
      } else if (object.name.startsWith('trim-')) {
        intensity = 0.45; // cockpit trim (door cards, leather, fabric):
        // a touch more env definition so moulded/leather surfaces keep
        // readable shading in the cockpit view instead of going flat
      } else if (material.roughness <= 0.3) {
        intensity = 0.9; // glossy paint / glass-like
      } else {
        intensity = 0.3; // painted skin, wood, matte props
      }
      if (environment && intensity !== null) {
        material.envMap = environment;
        material.envMapIntensity = intensity;
        material.needsUpdate = true;
      }
    }
  });
}

// Per-frame: keep the shadowless fill/bounce directions anchored on the
// aircraft (directional lights only care about position→target), and
// run the one-time material polish once the world is built.
export function updateLighting(scene, plane) {
  const lighting = scene.userData.lighting;
  if (!lighting) return;
  if (!lighting.polished) {
    lighting.polished = true;
    polishMaterials(scene);
  }
  // Interior fill: create once the cockpit group exists, then mirror
  // its visibility (main.js shows it only in cockpit view). The
  // explicit toggle is belt-and-braces — as children of the hidden
  // group the lights are already skipped in chase/tower views.
  ensureInteriorLights(scene);
  if (lighting.interiorLights && lighting.interiorHost) {
    const on = lighting.interiorHost.visible;
    for (const light of lighting.interiorLights) light.visible = on;
  }
  if (!plane || !plane.position) return;
  lighting.fillLight.position.copy(plane.position).addScaledVector(FILL_DIRECTION, 300);
  lighting.fillLight.target.position.copy(plane.position);
  lighting.fillLight.target.updateMatrixWorld();
  lighting.bounceLight.position.copy(plane.position).addScaledVector(BOUNCE_DIRECTION, 300);
  lighting.bounceLight.target.position.copy(plane.position);
  lighting.bounceLight.target.updateMatrixWorld();
}
