// sky.js — VD6-SKY sunset realism pass (V6-SKY, 2026-11-26).
// One job: make the dawn sky match the user's sunset references
// (chase-reference.jpg / tower-reference.jpg) — deep-violet zenith →
// magenta → saturated orange → gold horizon, sun low with a layered
// halo, warm haze strata, a cheap god-ray fan, and fog warmed to the
// horizon so distant islands silhouette in layers.
//
// render.js (claimed by V6-WORLD / V6-WORLD-LOOK) keeps owning the
// dome mesh, lights and clouds; this module only swaps the dome's
// material for a richer shader and adds sprite/plane extras. Hook:
// enhanceSky(scene, sunDirection) once from buildSky(),
// updateSkyExtras(scene, plane) per frame from updateSky().
// Cost: +5 draw calls (2 glow sprites, 2 haze sprites, 1 merged
// ray fan). Procedural/canvas only — no assets, no logic touched.

import * as THREE from 'three';

// Sunset palette read off the references (chase: violet zenith,
// magenta mid-sky, orange band, gold at the sun; tower: same family
// with a deeper red-orange horizon away from the sun).
const SUNSET = {
  zenith: 0x2e1a5e, // deep violet overhead
  violet: 0x5a2a7a, // purple upper sky
  rose: 0xb84a72, // magenta-pink mid sky
  orange: 0xff7a38, // saturated orange band
  horizonGold: 0xffc46b, // gold right at the horizon / sun
  sunCore: 0xfff3c4, // near-white sun disc core
  sunGlow: 0xffb45e, // warm halo colour
  haze: 0xff9a5c, // haze strata tint
  belowHorizon: 0x4a2c3a, // dusky mauve under the horizon line
  fog: 0xf2a06e, // warm rose-orange fog (was 0xe8a07a)
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

function makeHazeBandTexture() {
  // Wide, short canvas: vertical gradient with 3 soft strata lines,
  // fading at both horizontal ends so the stretched sprite melts
  // into the sky instead of ending on a hard edge.
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  const vertical = context.createLinearGradient(0, 0, 0, 64);
  vertical.addColorStop(0, 'rgba(255,154,92,0)');
  vertical.addColorStop(0.35, 'rgba(255,154,92,0.55)');
  vertical.addColorStop(0.55, 'rgba(255,180,110,0.75)');
  vertical.addColorStop(0.72, 'rgba(255,154,92,0.5)');
  vertical.addColorStop(1, 'rgba(255,154,92,0)');
  context.fillStyle = vertical;
  context.fillRect(0, 0, 512, 64);
  // Strata: thin brighter lines inside the band (dust layers catching
  // the low sun), irregular alpha so they don't read as stripes.
  context.globalCompositeOperation = 'lighter';
  const lines = [[20, 0.18], [30, 0.26], [41, 0.15]];
  for (const [y, alpha] of lines) {
    context.fillStyle = 'rgba(255,220,170,' + alpha + ')';
    context.fillRect(0, y, 512, 2);
  }
  context.globalCompositeOperation = 'destination-in';
  const horizontal = context.createLinearGradient(0, 0, 512, 0);
  horizontal.addColorStop(0, 'rgba(0,0,0,0)');
  horizontal.addColorStop(0.18, 'rgba(0,0,0,1)');
  horizontal.addColorStop(0.82, 'rgba(0,0,0,1)');
  horizontal.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = horizontal;
  context.fillRect(0, 0, 512, 64);
  return new THREE.CanvasTexture(canvas);
}

function makeRayTexture() {
  // One god-ray shaft: bright at the sun end, fading along its
  // length, soft across its width. Drawn vertically (v = length).
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const along = context.createLinearGradient(0, 256, 0, 0);
  along.addColorStop(0, 'rgba(255,210,150,0.9)');
  along.addColorStop(0.35, 'rgba(255,190,130,0.45)');
  along.addColorStop(1, 'rgba(255,180,120,0)');
  context.fillStyle = along;
  context.fillRect(0, 0, 64, 256);
  context.globalCompositeOperation = 'destination-in';
  const across = context.createLinearGradient(0, 0, 64, 0);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(0.5, 'rgba(0,0,0,1)');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = across;
  context.fillRect(0, 0, 64, 256);
  return new THREE.CanvasTexture(canvas);
}

// ---------------------------------------------------------------------------
// Richer dome shader (material swap — 0 new draw calls)
// ---------------------------------------------------------------------------

function buildSunsetMaterial(sunDirection) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenithColour: { value: new THREE.Color(SUNSET.zenith) },
      violetColour: { value: new THREE.Color(SUNSET.violet) },
      roseColour: { value: new THREE.Color(SUNSET.rose) },
      orangeColour: { value: new THREE.Color(SUNSET.orange) },
      horizonColour: { value: new THREE.Color(SUNSET.horizonGold) },
      belowColour: { value: new THREE.Color(SUNSET.belowHorizon) },
      sunCoreColour: { value: new THREE.Color(SUNSET.sunCore) },
      sunGlowColour: { value: new THREE.Color(SUNSET.sunGlow) },
      hazeColour: { value: new THREE.Color(SUNSET.haze) },
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
      'uniform vec3 violetColour;',
      'uniform vec3 roseColour;',
      'uniform vec3 orangeColour;',
      'uniform vec3 horizonColour;',
      'uniform vec3 belowColour;',
      'uniform vec3 sunCoreColour;',
      'uniform vec3 sunGlowColour;',
      'uniform vec3 hazeColour;',
      'uniform vec3 sunDirection;',
      'varying vec3 vWorldDirection;',
      'void main() {',
      '  vec3 dir = normalize(vWorldDirection);',
      '  vec3 sunDir = normalize(sunDirection);',
      '  float height = clamp(dir.y, -1.0, 1.0);',
      // 5-stop sunset gradient: gold horizon → orange → rose →
      // violet → deep-violet zenith (references, both shots).
      '  vec3 colour = horizonColour;',
      '  colour = mix(colour, orangeColour, smoothstep(0.0, 0.07, height));',
      '  colour = mix(colour, roseColour, smoothstep(0.06, 0.20, height));',
      '  colour = mix(colour, violetColour, smoothstep(0.18, 0.45, height));',
      '  colour = mix(colour, zenithColour, smoothstep(0.42, 0.78, height));',
      '  colour = mix(colour, belowColour, smoothstep(0.0, -0.22, height));',
      // Sun-azimuth warmth: the sky burns brighter toward the sun
      // and cools away from it (chase ref: gold right, violet left).
      '  vec3 flatDir = vec3(dir.x, 0.0, dir.z);',
      '  vec3 flatSun = vec3(sunDir.x, 0.0, sunDir.z);',
      '  float azimuth = max(dot(flatDir / max(length(flatDir), 0.001), flatSun / max(length(flatSun), 0.001)), 0.0);',
      '  float warmth = pow(azimuth, 2.0) * (1.0 - smoothstep(0.0, 0.38, height));',
      '  colour += orangeColour * warmth * 0.35;',
      '  colour += horizonColour * pow(azimuth, 6.0) * (1.0 - smoothstep(0.0, 0.16, height)) * 0.45;',
      // Warm haze strata hugging the horizon (dust bands).
      '  float strata = sin(height * 110.0 + azimuth * 3.0) * 0.5 + 0.5;',
      '  float hazeBand = exp(-max(height, 0.0) * 10.0) * (0.35 + 0.65 * strata);',
      '  colour = mix(colour, hazeColour, hazeBand * 0.16);',
      // Layered sun: tight disc + inner glow + wide halo + a faint
      // horizontal streak through the disc (low-sun glare).
      '  float sunAmount = max(dot(dir, sunDir), 0.0);',
      '  colour += sunCoreColour * pow(sunAmount, 900.0) * 2.4;', // disc
      '  colour += sunGlowColour * pow(sunAmount, 90.0) * 0.85;', // inner glow
      '  colour += sunGlowColour * pow(sunAmount, 6.0) * 0.32;', // wide halo
      '  float streak = pow(sunAmount, 160.0) * exp(-abs(dir.y - sunDir.y) * 55.0);',
      '  colour += sunGlowColour * streak * 0.5;',
      '  gl_FragColor = vec4(colour, 1.0);',
      '}',
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// God-ray fan: 4 additive gradient quads merged into 1 draw call
// ---------------------------------------------------------------------------

function buildGodRays(sunDirection) {
  // Quads radiate from the sun point, fanned like the tower
  // reference's diagonal shafts. They live in a group that faces
  // the world centre (cameras stay within a few km of it), so the
  // fan reads from chase/cockpit/tower without per-frame billboards.
  const sunPosition = sunDirection.clone().multiplyScalar(10500);
  const positions = [];
  const uvs = [];
  const indices = [];
  // Fan angles (rad from "up" in the fan plane), half-width at the
  // far end, length. Near-vertical shafts tilted like the ref.
  const rays = [
    { angle: -0.62, width: 520, length: 7200 },
    { angle: -0.28, width: 380, length: 8000 },
    { angle: 0.08, width: 460, length: 7600 },
    { angle: 0.44, width: 330, length: 6800 },
  ];
  let vertexBase = 0;
  for (const ray of rays) {
    const dirX = Math.sin(ray.angle);
    const dirY = Math.cos(ray.angle);
    const perpX = dirY;
    const perpY = -dirX;
    const baseHalf = ray.width * 0.12; // narrow at the sun
    const tipHalf = ray.width * 0.5; // spreads as it travels
    const tipX = dirX * ray.length;
    const tipY = dirY * ray.length;
    positions.push(
      -perpX * baseHalf, -perpY * baseHalf, 0,
      perpX * baseHalf, perpY * baseHalf, 0,
      tipX + perpX * tipHalf, tipY + perpY * tipHalf, 0,
      tipX - perpX * tipHalf, tipY - perpY * tipHalf, 0,
    );
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(vertexBase, vertexBase + 1, vertexBase + 2, vertexBase, vertexBase + 2, vertexBase + 3);
    vertexBase += 4;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicMaterial({
    map: makeRayTexture(),
    transparent: true,
    opacity: 0.18, // VD6-SKY tune: 0.14 read too faint vs tower ref shafts
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    side: THREE.DoubleSide,
  });
  const fan = new THREE.Mesh(geometry, material);
  fan.name = 'sunGodRays';
  fan.position.copy(sunPosition);
  fan.frustumCulled = false;
  fan.renderOrder = -8; // after the dome (-10), before world geometry
  // Face the fan plane toward the world centre, "up" kept vertical
  // so shafts rake diagonally across the sky like the reference.
  fan.lookAt(0, sunPosition.y * 0.35, 0);
  return fan;
}

// ---------------------------------------------------------------------------
// Public hook API
// ---------------------------------------------------------------------------

export function enhanceSky(scene, sunDirection) {
  const sky = scene.userData.sky;
  if (!sky || !sky.skyDome) return;

  // 1) Richer gradient on the existing dome (0 new draws).
  sky.skyDome.material.dispose();
  sky.skyDome.material = buildSunsetMaterial(sunDirection);

  // 2) Fog warmed to the new horizon so distant islands layer as
  // silhouettes against it (range unchanged — readability kept).
  if (scene.fog) scene.fog.color.setHex(SUNSET.fog);

  // 3) Sprite/plane extras in one group that rides with the plane
  // (updateSkyExtras), exactly like the dome does.
  const group = new THREE.Group();
  group.name = 'sunsetSkyExtras';

  const sunPosition = sunDirection.clone().multiplyScalar(11500);

  // Tight bright core around the shader disc.
  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialGlowTexture([
      [0, 'rgba(255,250,230,1)'],
      [0.18, 'rgba(255,233,176,0.85)'],
      [0.5, 'rgba(255,200,120,0.28)'],
      [1, 'rgba(255,180,94,0)'],
    ]),
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  core.name = 'sunCoreGlow';
  core.scale.set(950, 950, 1);
  core.position.copy(sunPosition);
  group.add(core);

  // Very wide faint halo (the existing render.js sprite at 2100
  // stays as the mid layer between core and this).
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialGlowTexture([
      [0, 'rgba(255,190,120,0.5)'],
      [0.4, 'rgba(255,160,100,0.22)'],
      [1, 'rgba(255,140,90,0)'],
    ]),
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  halo.name = 'sunWideHalo';
  halo.scale.set(5400, 5400, 1);
  halo.position.copy(sunPosition);
  group.add(halo);

  // Warm haze bands: stretched sprites on the horizon — bright on
  // the sun side, fainter/cooler opposite so the whole horizon
  // carries a dust layer.
  const hazeTexture = makeHazeBandTexture();
  const sunAzimuth = new THREE.Vector3(sunDirection.x, 0, sunDirection.z).normalize();
  const hazeSun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: hazeTexture,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  hazeSun.name = 'hazeBandSun';
  hazeSun.scale.set(9800, 760, 1);
  hazeSun.position.copy(sunAzimuth).multiplyScalar(10800);
  hazeSun.position.y = 320;
  group.add(hazeSun);

  const hazeAnti = new THREE.Sprite(new THREE.SpriteMaterial({
    map: hazeTexture,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  }));
  hazeAnti.name = 'hazeBandAntiSun';
  hazeAnti.scale.set(9800, 640, 1);
  hazeAnti.position.copy(sunAzimuth).multiplyScalar(-10800);
  hazeAnti.position.y = 280;
  group.add(hazeAnti);

  // God-ray fan (1 merged draw).
  group.add(buildGodRays(sunDirection));

  scene.add(group);
  scene.userData.skyExtras = group;
  return group;
}

// Per-frame: extras ride with the aircraft like the dome does, so
// the sun/haze/rays never get closer. No allocation.
export function updateSkyExtras(scene, plane) {
  const group = scene.userData.skyExtras;
  if (group && plane && plane.position) group.position.copy(plane.position);
}
