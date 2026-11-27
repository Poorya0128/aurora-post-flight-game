// sea.js — SEA visual upgrade for the AURORA POST sea (reference-matched).
// One job: replace the flat textured sea plane + separate additive glint
// quad (world.js buildSea) with a single custom-shader sea matched to the
// env1/env2 references: saturated deep-blue offshore grading to turquoise
// shallows (baked heightfield shallowness), Fresnel sky reflection of a
// peach-horizon → blue-violet-zenith gradient, a bright sun-glitter path
// (Blinn specular through perturbed normals + twinkling sparkle), a
// two-band animated foam ring (bright waterline + soft outer lace) on
// every coastline, and a gentle vertex swell damped at the coasts.
// Everything procedural (canvas/DataTextures only, no assets, seeded),
// one draw call, fragment cost kept modest for SwiftShader/mid GPUs
// (2 normal samples + 1 mask sample, no per-frame allocations).
//
// Hook contract (minimal, world.js/render.js untouched — they are held
// by V6-WORLD-LOOK): main.js calls upgradeSea(scene, world) once after
// buildWorld() and updateSea(frameSeconds) each frame. upgradeSea finds
// the existing 'sea-plane' mesh by name, swaps in a segmented geometry +
// this shader material, and hides the old 'sea-sun-glint' quad (the
// shader's specular lane replaces it). Logic is untouched: heightAt /
// seaLevel / flight all read world.js constants, never this mesh.
// If anything here throws, main.js catches it and the original sea
// renders exactly as before.

import * as THREE from 'three';
import { cameraLink } from './camera-link.js';

// Palette anchors — reference-matched (env1/env2): cobalt offshore,
// turquoise shallows, peach horizon → blue-violet zenith sky reflection.
// Sky colours are uniforms (uHorizonColour / uMidColour / uZenithColour
// on seaState.uniforms) so the coordinator can sync them with the sky.
const SEA_DEEP = 0x0d4f8a;      // saturated deep-blue offshore (env1 foreground)
const SEA_SHALLOW = 0x24c2b0;   // bright turquoise shallows near islands (round-2: more aqua)
const SKY_ZENITH = 0x4b5cc4;    // blue-violet zenith (round-2 sky sync)
const SKY_MID = 0xb8a9d9;       // pale lavender-blue mid-sky (round-2 sky sync)
const SKY_HORIZON = 0xffc9a3;   // peach horizon (brief palette, kept)
const SUN_COLOUR = 0xffd166;
const GLINT_COLOUR = 0xffd9a0;  // near-white warm gold glitter path (env1/env2 sparkle)
const FOAM_COLOUR = 0xffffff;   // bright white foam ring (env1 coastline)

// Fallback sun direction (must match render.js SUN_DIRECTION: 9°
// elevation, 0.18 southward tilt). cameraLink.sunDirection wins when set.
const FALLBACK_SUN = new THREE.Vector3(
  Math.cos((9 * Math.PI) / 180),
  Math.sin((9 * Math.PI) / 180),
  0.18,
).normalize();

const SEA_SIZE_M = 42000;       // matches world.js sea plane
const SEA_SEGMENTS = 128;       // swell resolution (~328 m cells)
const MASK_SIZE = 512;          // shore/depth mask resolution
const MASK_EXTENT_M = 12000;    // playable square the mask covers

let seaState = null; // { material, uniforms, mesh, time }

// ---------------------------------------------------------------------------
// Deterministic helpers (same LCG family as world.js / world-dressing.js)
// ---------------------------------------------------------------------------

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function smoothStep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Tileable value noise: lattice coordinates wrap at `period`, so the
// heightfield (and its normals) tile seamlessly under RepeatWrapping.
function tileableNoise(x, y, period, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const hash = (gx, gy) => {
    const wx = ((gx % period) + period) % period;
    const wy = ((gy % period) + period) % period;
    let h = Math.imul(wx, 374761393) + Math.imul(wy, 668265263) + Math.imul(seed, 974634211);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Wave-normal canvas texture: fBm heightfield (3 tileable octaves) →
// Sobel normals, RGB = tangent-space normal, A unused. Sampled twice in
// the shader at different scales/scroll rates for moving chop.
function makeWaveNormalTexture() {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const heights = new Float32Array(size * size);
  const octaves = [
    { period: 6, amp: 0.55, seed: 811 },
    { period: 12, amp: 0.3, seed: 1733 },
    { period: 24, amp: 0.15, seed: 2909 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const octave of octaves) {
        h += tileableNoise(
          (x / size) * octave.period, (y / size) * octave.period,
          octave.period, octave.seed) * octave.amp;
      }
      heights[y * size + x] = h;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(size, size);
  const strength = 2.2;
  const at = (x, y) => heights[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const idx = (y * size + x) * 4;
      image.data[idx] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      image.data[idx + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      image.data[idx + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
      image.data[idx + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Shore/depth mask baked from the real heightfield over the playable
// square: R = foam factor (1 at the waterline, fading by ~3.2 m depth),
// G = shallowness (1 at depth 0 → 0 at 18 m), B = normalised depth.
// Texels far from every island skip heightAt (open-sea seabed is deep).
function makeShoreMaskTexture(world) {
  const heightAt = world && typeof world.heightAt === 'function' ? world.heightAt : null;
  const seaLevel = world && typeof world.seaLevel === 'number' ? world.seaLevel : 0;
  const islands = world && Array.isArray(world.islands) ? world.islands : [];
  const data = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  const half = MASK_EXTENT_M / 2;
  for (let row = 0; row < MASK_SIZE; row++) {
    const z = -half + ((row + 0.5) / MASK_SIZE) * MASK_EXTENT_M;
    for (let col = 0; col < MASK_SIZE; col++) {
      const x = -half + ((col + 0.5) / MASK_SIZE) * MASK_EXTENT_M;
      const idx = (row * MASK_SIZE + col) * 4;
      let depth = 9; // open-sea seabed default (world.js: -7..-9 m)
      let nearIsland = false;
      for (let i = 0; i < islands.length; i++) {
        const island = islands[i];
        const centre = island.centre || island.center || island.position;
        if (!centre) continue;
        const dx = x - centre.x;
        const dz = z - centre.z;
        const reach = (island.radius || 600) * 1.5 + 120;
        if (dx * dx + dz * dz <= reach * reach) { nearIsland = true; break; }
      }
      if (nearIsland && heightAt) depth = seaLevel - heightAt(x, z);
      // Round-2: foam hugs the waterline (was 1.2–7 m → thick halo);
      // shallowness reaches deeper (was 12 m) so the aqua fringe
      // reads from altitude without turning whole bays turquoise.
      const foam = depth <= 0 ? 1 : 1 - smoothStep(0.4, 3.2, depth);
      const shallow = depth <= 0 ? 1 : Math.max(0, 1 - depth / 18);
      data[idx] = Math.round(foam * 255);
      data[idx + 1] = Math.round(shallow * 255);
      data[idx + 2] = Math.round(Math.min(1, Math.max(0, depth / 14)) * 255);
      data[idx + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, MASK_SIZE, MASK_SIZE, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Shader
// ---------------------------------------------------------------------------

const SEA_VERTEX_SHADER = [
  '#include <fog_pars_vertex>',
  'uniform float uTime;',
  'uniform sampler2D uShoreMask;',
  'uniform float uMaskExtent;',
  'varying vec3 vWorldPosition;',
  'varying vec2 vMaskUv;',
  'void main() {',
  '  vec4 worldPos = modelMatrix * vec4(position, 1.0);',
  '  vec2 maskUv = (worldPos.xz + uMaskExtent * 0.5) / uMaskExtent;',
  '  vMaskUv = maskUv;',
  // Gentle swell: two long sine trains, damped to near-zero at the
  // waterline (mask R = 1 on shore) so waves never poke through sand.
  '  float shoreDamp = 1.0 - texture2D(uShoreMask, maskUv).r * 0.9;',
  '  float swell = sin(worldPos.x * 0.0056 + worldPos.z * 0.0021 + uTime * 0.55)',
  '              + 0.6 * sin(worldPos.x * -0.0028 + worldPos.z * 0.0075 + uTime * 0.38);',
  '  vec3 transformed = position + normal * (swell * 0.32 * shoreDamp);',
  '  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);',
  '  gl_Position = projectionMatrix * mvPosition;',
  '  vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
  '  #include <fog_vertex>',
  '}',
].join('\n');

const SEA_FRAGMENT_SHADER = [
  '#include <fog_pars_fragment>',
  'uniform float uTime;',
  'uniform vec3 uSunDirection;',
  'uniform sampler2D uWaveNormal;',
  'uniform sampler2D uShoreMask;',
  'uniform vec3 uDeepColour;',
  'uniform vec3 uShallowColour;',
  'uniform vec3 uZenithColour;',
  'uniform vec3 uMidColour;',
  'uniform vec3 uHorizonColour;',
  'uniform vec3 uSunColour;',
  'uniform vec3 uGlintColour;',
  'uniform vec3 uFoamColour;',
  'varying vec3 vWorldPosition;',
  'varying vec2 vMaskUv;',
  'float hash12(vec2 p) {',
  '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
  '  p3 += dot(p3, p3.yzx + 33.33);',
  '  return fract((p3.x + p3.y) * p3.z);',
  '}',
  'void main() {',
  '  vec3 toCamera = cameraPosition - vWorldPosition;',
  '  float viewDistance = length(toCamera);',
  '  vec3 viewDir = toCamera / max(viewDistance, 0.001);',
  '  vec3 sunDir = normalize(uSunDirection);',
  '  vec2 worldXZ = vWorldPosition.xz;',
  // Two scrolling normal layers (different scale/rate/direction bias)
  // blended into one perturbed up-normal. Detail fades with distance
  // so the horizon lane reads as glitter, not aliasing noise.
  '  vec2 uv1 = worldXZ * 0.011 + vec2(uTime * 0.013, uTime * 0.0045);',
  '  vec2 uv2 = worldXZ * 0.0037 + vec2(-uTime * 0.0052, uTime * 0.0088);',
  '  vec3 n1 = texture2D(uWaveNormal, uv1).rgb * 2.0 - 1.0;',
  '  vec3 n2 = texture2D(uWaveNormal, uv2).rgb * 2.0 - 1.0;',
  '  float detailFade = 1.0 / (1.0 + viewDistance * 0.00045);',
  '  vec2 slope = (n1.xy * 0.85 + n2.xy * 0.65) * (0.35 + 0.65 * detailFade);',
  '  vec3 normal = normalize(vec3(slope.x, 1.0, slope.y));',
  // Shore mask: foam factor / shallowness / depth.
  '  vec3 shore = texture2D(uShoreMask, vMaskUv).rgb;',
  // Fresnel sky reflection (Schlick) of the peach → violet gradient +
  // sun glow in the reflected ray (env2 peach/violet water mirror).
  '  float fresnel = 0.025 + 0.975 * pow(1.0 - max(dot(viewDir, normal), 0.0), 5.0);',
  '  vec3 reflectDir = reflect(-viewDir, normal);',
  '  vec3 skyReflect = mix(uHorizonColour, uMidColour, smoothstep(-0.02, 0.22, reflectDir.y));',
  '  skyReflect = mix(skyReflect, uZenithColour, smoothstep(0.18, 0.6, reflectDir.y));',
  '  skyReflect += uSunColour * pow(max(dot(reflectDir, sunDir), 0.0), 10.0) * 0.35;',
  // Deep-blue offshore → turquoise shallows via baked shallowness (G).
  // Round-2: stronger lift (pow 0.55 × 0.92, was 0.75 × 0.85) + wider
  // 18 m bake so the aqua fringe is clear around every island from
  // altitude. Reflection cap cut (×0.60, max 0.45; was ×0.85, max 0.72)
  // so mid/far sea keeps its blue body instead of washing pale
  // pink-grey; the glitter lane below stays at full strength.
  '  vec3 base = mix(uDeepColour, uShallowColour, pow(shore.g, 0.55) * 0.92);',
  '  vec3 colour = mix(base, skyReflect, clamp(fresnel * 0.60, 0.0, 0.45));',
  // Sun-glitter path (env1 bright lane / env2 sparkle flecks): tight
  // Blinn specular through the perturbed normal pools toward the sun
  // azimuth (uSunDirection); a twinkling hash sparkle breaks it into
  // flecks, and a flat-normal alignment term keeps the lane broad and
  // readable from altitude. A wide warm sheen sits under the flecks.
  '  vec3 halfDir = normalize(viewDir + sunDir);',
  '  float ndh = max(dot(normal, halfDir), 0.0);',
  '  float specTight = pow(ndh, 320.0);',
  '  float specWide = pow(ndh, 28.0);',
  '  vec3 flatReflect = reflect(-viewDir, vec3(0.0, 1.0, 0.0));',
  '  float lane = pow(max(dot(flatReflect, sunDir), 0.0), 2.6);',
  '  vec2 sparkleCell = floor(worldXZ * 0.7) + floor(uTime * 2.8) * 17.0;',
  '  float sparkle = smoothstep(0.42, 0.92, hash12(sparkleCell) * 0.6 + n1.z * 0.55);',
  '  float glitter = specTight * (0.3 + sparkle * 1.9) * (0.35 + lane * 1.3);',
  '  colour += uGlintColour * glitter * 5.5;',
  '  colour += uGlintColour * specWide * (0.2 + lane * 0.6);',
  // Animated two-band foam ring (env1 white coastline): bright
  // waterline band + softer outer lace, both carved from the baked
  // foam factor (R) and broken by the time-scrolling normal noise +
  // swash stripes, so the ring breathes and scrolls. No extra samples:
  // n1/n2 already scroll with uTime. Coast-surf ribbon (world-dressing)
  // still draws on top; this is the water-side foam edge.
  '  float swash = 0.5 + 0.5 * sin((worldXZ.x + worldXZ.y) * 0.13 - uTime * 1.35);',
  '  float laceNoise = n1.z * 0.5 + n2.z * 0.5;',
  // Round-2: thin bright waterline only (was 0.62–0.95 → thick uniform
  // halo). Inner band now hugs shore.r≈1; outer lace is narrower,
  // sparser (higher noise gate) and fainter (0.28, was 0.55). Swash +
  // scrolling laceNoise keep both bands animated.
  '  float innerBand = smoothstep(0.86, 0.98, shore.r);',
  '  float outerBand = smoothstep(0.45, 0.86, shore.r) * (1.0 - innerBand);',
  '  float innerFoam = innerBand * smoothstep(0.25, 0.65, swash * 0.45 + laceNoise * 0.65);',
  '  float outerFoam = outerBand * smoothstep(0.68, 0.95, laceNoise * 0.7 + swash * 0.3) * 0.28;',
  '  float foam = clamp(innerFoam + outerFoam, 0.0, 1.0);',
  '  colour = mix(colour, uFoamColour, foam);',
  '  gl_FragColor = vec4(colour, 1.0);',
  '  #include <tonemapping_fragment>',
  '  #include <colorspace_fragment>',
  // Gentler sea haze than the scene fog (same colour, stretched range):
  // the stock 800–6000 m fog washed the mid-distance sea pale pink in
  // sea-chase.jpg v1; the reference keeps blue water to the horizon.
  '  #ifdef USE_FOG',
  '    #ifdef FOG_EXP2',
  // Round-2: 0.55 → 0.36 (same FogExp2 structure, less wash) so the
  // mid-distance sea keeps its blue body to the horizon.
  '      float seaFogDensity = fogDensity * 0.36;',
  '      float seaFogFactor = 1.0 - exp(-seaFogDensity * seaFogDensity * vFogDepth * vFogDepth);',
  '    #else',
  '      float seaFogFactor = smoothstep(fogNear * 2.2, fogFar * 1.9, vFogDepth);',
  '    #endif',
  '    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, seaFogFactor);',
  '  #endif',
  '}',
].join('\n');

function createSeaMaterial(waveNormalTexture, shoreMaskTexture, sunDirection) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uSunDirection: { value: sunDirection.clone() },
      uWaveNormal: { value: waveNormalTexture },
      uShoreMask: { value: shoreMaskTexture },
      uMaskExtent: { value: MASK_EXTENT_M },
      uDeepColour: { value: new THREE.Color(SEA_DEEP) },
      uShallowColour: { value: new THREE.Color(SEA_SHALLOW) },
      uZenithColour: { value: new THREE.Color(SKY_ZENITH) },
      uMidColour: { value: new THREE.Color(SKY_MID) },
      uHorizonColour: { value: new THREE.Color(SKY_HORIZON) },
      uSunColour: { value: new THREE.Color(SUN_COLOUR) },
      uGlintColour: { value: new THREE.Color(GLINT_COLOUR) },
      uFoamColour: { value: new THREE.Color(FOAM_COLOUR) },
    },
  ]);
  // UniformsUtils.merge clones values; re-bind the textures after merge
  // (cloned texture uniforms keep the reference, but be explicit).
  uniforms.uWaveNormal.value = waveNormalTexture;
  uniforms.uShoreMask.value = shoreMaskTexture;
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SEA_VERTEX_SHADER,
    fragmentShader: SEA_FRAGMENT_SHADER,
    fog: true,
  });
}

// ---------------------------------------------------------------------------
// Public API (called from main.js)
// ---------------------------------------------------------------------------

export function upgradeSea(scene, world) {
  if (!scene || seaState) return null;
  // Diagnostic kill-switch (?nosea=1): leaves the original world.js sea
  // in place so captures can A/B the shader's cost/behaviour.
  try {
    if (typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).has('nosea')) return null;
  } catch (error) { /* fall through to the upgrade */ }
  let seaMesh = null;
  let glintMesh = null;
  scene.traverse((object) => {
    if (object.name === 'sea-plane') seaMesh = object;
    if (object.name === 'sea-sun-glint') glintMesh = object;
  });
  if (!seaMesh) return null; // world.js sea missing: leave everything as-is

  const sunDirection = (cameraLink && cameraLink.sunDirection)
    ? cameraLink.sunDirection.clone() : FALLBACK_SUN.clone();
  const waveNormalTexture = makeWaveNormalTexture();
  const shoreMaskTexture = makeShoreMaskTexture(world);
  if (!waveNormalTexture) return null;

  const material = createSeaMaterial(waveNormalTexture, shoreMaskTexture, sunDirection);

  // Segmented geometry for the vertex swell (same size/transform as the
  // original plane; the mesh rotation/position are untouched).
  const oldGeometry = seaMesh.geometry;
  seaMesh.geometry = new THREE.PlaneGeometry(SEA_SIZE_M, SEA_SIZE_M, SEA_SEGMENTS, SEA_SEGMENTS);
  if (oldGeometry) oldGeometry.dispose();
  const oldMaterial = seaMesh.material;
  seaMesh.material = material;
  if (oldMaterial && oldMaterial.dispose) oldMaterial.dispose();

  // The shader specular lane replaces the additive glint quad.
  if (glintMesh) glintMesh.visible = false;

  // seaState.uniforms is the sync surface for the coordinator:
  // uHorizonColour / uMidColour / uZenithColour (sky reflection),
  // uSunDirection / uSunColour / uGlintColour (glitter), uDeepColour /
  // uShallowColour / uFoamColour, plus uTime (advanced by updateSea).
  seaState = { material, uniforms: material.uniforms, mesh: seaMesh, time: 0 };
  return seaState;
}

export function updateSea(frameSeconds) {
  if (!seaState) return;
  const dt = typeof frameSeconds === 'number' && frameSeconds > 0 ? frameSeconds : 0;
  seaState.time += dt;
  seaState.uniforms.uTime.value = seaState.time;
}
