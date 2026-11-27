// sky.js — golden-hour sky pass (visual upgrade, 2026-11-27).
// One job: make the sky match the user's golden-hour references
// (env1–env9) — soft blue-violet zenith melting through pale
// lavender-blue into a peach horizon (pink only near the sun), warm gold blooming toward the sun, a bright
// sun disc in a soft halo, and peach fog so distant islands haze
// into the horizon. Smooth dithered gradient (no banded stops, no
// strata stripes, no god-ray fan, no horizontal streak).
//
// render.js keeps owning the dome mesh, lights and clouds; this
// module only swaps the dome's material for the golden-hour shader
// and adds two additive glow sprites. Hook: enhanceSky(scene,
// sunDirection) once from buildSky(), updateSkyExtras(scene, plane)
// per frame from updateSky(). Cost: +2 draw calls (2 glow sprites).
// Procedural/canvas only — no assets, no logic touched.

import * as THREE from 'three';

// Golden-hour palette read off the reference set (env1 island / env2
// sea: blue-violet zenith, pale lavender-blue mid, peach horizon;
// env4 hill / env6 runway / env7 barn: same family, sun gold on the
// horizon). Round 2: the old saturated pink mid (0xd48bc4) read
// magenta across the whole sky; references keep pink only near the
// sun azimuth, so the global mid stop is now pale lavender-blue and
// pink is added azimuthally in the shader (pinkNearSun below).
const GOLDEN = {
  zenith: 0x4b5cc4, // soft blue-violet overhead
  lavender: 0x8f8fd2, // blue-violet upper sky (was 0x9a7fd0)
  rose: 0xb8a9d9, // pale lavender-blue mid sky (was pink 0xd48bc4); == render.js PALETTE.skyMid
  pinkNearSun: 0xe8a8c8, // soft pink, mixed in only toward the sun azimuth
  peach: 0xffb380, // peach horizon
  sunGold: 0xffd98a, // warm gold at the sun azimuth
  sunCore: 0xfff6d8, // near-white sun disc core
  sunGlow: 0xffc987, // warm halo colour
  belowHorizon: 0x7a5a6e, // dusky mauve under the horizon line
  fog: 0xf5b88a, // peach FogExp2 haze (matches render.js PALETTE.fog)
};

// ---------------------------------------------------------------------------
// Canvas textures (procedural only)
// ---------------------------------------------------------------------------

function makeRadialGlowTexture(stops, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const half = size / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, colour] of stops) gradient.addColorStop(offset, colour);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------------------
// Golden-hour dome shader (material swap — 0 new draw calls)
// ---------------------------------------------------------------------------

function buildGoldenMaterial(sunDirection) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenithColour: { value: new THREE.Color(GOLDEN.zenith) },
      lavenderColour: { value: new THREE.Color(GOLDEN.lavender) },
      roseColour: { value: new THREE.Color(GOLDEN.rose) },
      pinkColour: { value: new THREE.Color(GOLDEN.pinkNearSun) },
      peachColour: { value: new THREE.Color(GOLDEN.peach) },
      sunGoldColour: { value: new THREE.Color(GOLDEN.sunGold) },
      belowColour: { value: new THREE.Color(GOLDEN.belowHorizon) },
      sunCoreColour: { value: new THREE.Color(GOLDEN.sunCore) },
      sunGlowColour: { value: new THREE.Color(GOLDEN.sunGlow) },
      sunDirection: { value: sunDirection.clone() },
    },
    vertexShader: [
      'varying vec3 vWorldDirection;',
      'void main() {',
      '  vWorldDirection = normalize(position);',
      '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
      '  gl_Position = projectionMatrix * mvPosition;',
      '  gl_Position.z = gl_Position.w;', // pin to far plane (as before)
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 zenithColour;',
      'uniform vec3 lavenderColour;',
      'uniform vec3 roseColour;',
      'uniform vec3 pinkColour;',
      'uniform vec3 peachColour;',
      'uniform vec3 sunGoldColour;',
      'uniform vec3 belowColour;',
      'uniform vec3 sunCoreColour;',
      'uniform vec3 sunGlowColour;',
      'uniform vec3 sunDirection;',
      'varying vec3 vWorldDirection;',
      'float skyHash(vec2 p) {',
      '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
      '}',
      'void main() {',
      '  vec3 dir = normalize(vWorldDirection);',
      '  vec3 sunDir = normalize(sunDirection);',
      '  float height = clamp(dir.y, -1.0, 1.0);',
      // Smooth 4-stop golden-hour gradient: peach horizon -> pale
      // lavender-blue mid -> blue-violet -> zenith. Wide smoothsteps
      // keep every transition soft (round 2: no global magenta band).
      '  vec3 colour = peachColour;',
      '  colour = mix(colour, roseColour, smoothstep(0.01, 0.26, height));',
      '  colour = mix(colour, lavenderColour, smoothstep(0.22, 0.52, height));',
      '  colour = mix(colour, zenithColour, smoothstep(0.48, 0.85, height));',
      '  colour = mix(colour, belowColour, smoothstep(0.0, -0.22, height));',
      // Warm gold bloom toward the sun azimuth, hugging the horizon
      // (references: gold at the sun, cooler pink-violet opposite).
      '  vec3 flatDir = vec3(dir.x, 0.0, dir.z);',
      '  vec3 flatSun = vec3(sunDir.x, 0.0, sunDir.z);',
      '  float azimuth = max(dot(flatDir / max(length(flatDir), 0.001), flatSun / max(length(flatSun), 0.001)), 0.0);',
      '  float goldBand = pow(azimuth, 3.0) * (1.0 - smoothstep(0.0, 0.30, height));',
      '  colour = mix(colour, sunGoldColour, goldBand * 0.55);',
      // Pink lives only near the sun azimuth (references env1/env2:
      // pink glow around the sun, lavender-blue opposite) — round 2.
      '  float pinkBand = pow(azimuth, 2.0) * (1.0 - smoothstep(0.02, 0.38, height))'
        + ' * smoothstep(-0.02, 0.10, height);',
      '  colour = mix(colour, pinkColour, pinkBand * 0.38);',
      '  colour += sunGoldColour * pow(azimuth, 8.0) * (1.0 - smoothstep(0.0, 0.14, height)) * 0.35;',
      // Sun: tight bright disc + soft inner glow + wide halo. No
      // streak, no rays — the references glow clean.
      '  float sunAmount = max(dot(dir, sunDir), 0.0);',
      '  colour += sunCoreColour * pow(sunAmount, 800.0) * 2.2;', // disc
      '  colour += sunGlowColour * pow(sunAmount, 60.0) * 0.55;', // inner glow
      '  colour += sunGlowColour * pow(sunAmount, 5.0) * 0.22;', // wide halo
      // Ordered dither (+/- 1/255) breaks gradient banding.
      '  colour += (skyHash(gl_FragCoord.xy) - 0.5) / 255.0;',
      '  gl_FragColor = vec4(colour, 1.0);',
      '}',
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Public hook API
// ---------------------------------------------------------------------------

export function enhanceSky(scene, sunDirection) {
  const sky = scene.userData.sky;
  if (!sky || !sky.skyDome) return;

  // 1) Golden-hour gradient on the existing dome (0 new draws).
  sky.skyDome.material.dispose();
  sky.skyDome.material = buildGoldenMaterial(sunDirection);

  // 2) Fog tinted to the peach horizon so distant islands melt into
  // it (FogExp2 density lives in render.js createRenderer).
  if (scene.fog) scene.fog.color.setHex(GOLDEN.fog);

  // 3) Soft glow sprites in one group that rides with the plane
  // (updateSkyExtras), exactly like the dome does. The render.js
  // sun sprite stays as the mid layer between core and halo.
  const group = new THREE.Group();
  group.name = 'goldenSkyExtras';

  const sunPosition = sunDirection.clone().multiplyScalar(11500);

  // Tight bright core around the shader disc.
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialGlowTexture([
      [0, 'rgba(255,250,232,1)'],
      [0.18, 'rgba(255,238,190,0.8)'],
      [0.5, 'rgba(255,212,140,0.24)'],
      [1, 'rgba(255,196,130,0)'],
    ]),
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  core.name = 'sunCoreGlow';
  core.scale.set(900, 900, 1);
  core.position.copy(sunPosition);
  group.add(core);

  // Very wide faint halo.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialGlowTexture([
      [0, 'rgba(255,204,140,0.42)'],
      [0.4, 'rgba(255,182,128,0.18)'],
      [1, 'rgba(255,170,120,0)'],
    ]),
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  halo.name = 'sunWideHalo';
  halo.scale.set(5200, 5200, 1);
  halo.position.copy(sunPosition);
  group.add(halo);

  scene.add(group);
  scene.userData.skyExtras = group;
  return group;
}

// Per-frame: extras ride with the aircraft like the dome does, so
// the sun glow never gets closer. No allocation.
export function updateSkyExtras(scene, plane) {
  const group = scene.userData.skyExtras;
  if (group && plane && plane.position) group.position.copy(plane.position);
}
