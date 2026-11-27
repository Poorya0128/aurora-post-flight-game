// clouds.js — VD6-CLOUDS volumetric-LOOK puffy dawn clouds (V6-CLOUDS).
//
// Replaces the render.js two-tone sphere field (VD-10/VD6-22/VD6-LOOK
// lineage) with soft sunset-lit cumulus masses matched to the user's
// chase/tower references: clustered near-spherical puffs with a baked
// vertical colour gradient (warm cream-pink lit tops, rose mid, violet
// bellies), a sun-side orange boost, fresnel-faded silhouettes so puffs
// read as soft volumes instead of hard discs/UFOs, plus layered soft
// billboard shells (canvas-generated lumpy puff sprites) that halo every
// core and carry the high wispy layer.
//
// Budget: 3 draw calls total (1 instanced core mesh + 2 shell Points),
// vs 2 for the old field — well inside the +8 allowance. All drift is
// a shader time uniform (eastward 2.2 m/s with wrap + gentle bob, the
// same formula in core and shell shaders so halos stay glued to cores);
// the per-frame update only advances one float — zero allocations.
// Procedural only: fixed-seed placement (reproducible screenshots),
// canvas textures, no assets. Logic untouched; visual-only module.
//
// Exports: buildVolumetricClouds() -> Group,
//          updateVolumetricClouds(group, dt) — called from render.js
//          updateSky via the VD6-CLOUDS hook.

import * as THREE from 'three';

// Dawn sun direction — mirrors render.js SUN_DIRECTION (9° elevation,
// east + slight south tilt) so cloud lighting agrees with the sky dome
// and the directional light without importing render internals.
const SUN_DIRECTION = new THREE.Vector3(
  Math.cos(THREE.MathUtils.degToRad(9)),
  Math.sin(THREE.MathUtils.degToRad(9)),
  0.18,
).normalize();

// Scene fog from render.js createRenderer (PALETTE.fog, 800–6000 m) —
// the shell shader fades into the same warm haze manually.
const FOG_COLOUR = new THREE.Color(0xe8a07a);
const FOG_NEAR = 800;
const FOG_FAR = 6000;

const DRIFT_SPEED = 2.2; // m/s eastward, calm dawn air (matches old field)
const DRIFT_RANGE = 13000; // wrap span, ±6500 m (old field used the same)

// Deterministic pseudo-random generator (fixed seed) — same sky every
// run so judged screenshots stay reproducible (design.md §5.6).
function makeSeededRandom(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Lumpy soft puff sprite: overlapping radial gradients composited
// additively give an irregular cumulus alpha instead of a perfect disc.
// Two variants (different seeds) split across two Points draws so the
// shells never read as one stamped texture.
function makePuffTexture(seed) {
  const random = makeSeededRandom(seed);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  // Slight vertical squash: cumulus shells are wider than tall.
  ctx.translate(size / 2, size / 2);
  ctx.scale(1, 0.82);
  ctx.translate(-size / 2, -size / 2);
  const lobes = 16;
  for (let i = 0; i < lobes; i += 1) {
    const angle = random() * Math.PI * 2;
    const dist = random() * 62;
    const cx = size / 2 + Math.cos(angle) * dist;
    const cy = size / 2 + Math.sin(angle) * dist * 0.8;
    const radius = 34 + random() * 58;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(255,255,255,0.20)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.10)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  // Firm up the centre so the shell has a body, not just a halo ring.
  const core = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, 92);
  core.addColorStop(0, 'rgba(255,255,255,0.34)');
  core.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Core material: MeshStandardMaterial (keeps scene lights + fog) with
// injected gradient/sun/fresnel shading and shader drift. The vertical
// gradient uses the unit-sphere local Y, so every puff is lit from its
// own top regardless of where it sits in the cluster — the classic
// cheap volumetric-cloud look, with the sun boost on the east faces.
function makeCoreMaterial(sharedTime) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xff9e64,
    emissiveIntensity: 0.1, // lifts shadow sides warm; gradient does the rest
    roughness: 1.0,
    metalness: 0.0,
    flatShading: false,
    transparent: true,
    opacity: 0.97,
    depthWrite: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudTime = sharedTime;
    shader.uniforms.uCloudSunDir = { value: SUN_DIRECTION };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uCloudTime;',
          'varying float vCloudLocalY;',
          'varying vec3 vCloudNormalW;',
          'varying vec3 vCloudWorldPos;',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vCloudLocalY = position.y;',
          '#ifdef USE_INSTANCING',
          '  vCloudNormalW = normalize( mat3( instanceMatrix ) * normal );',
          '  vCloudWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;',
          '#else',
          '  vCloudNormalW = normal;',
          '  vCloudWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
          '#endif',
        ].join('\n'),
      )
      .replace(
        '#include <project_vertex>',
        [
          'vec4 mvPosition = vec4( transformed, 1.0 );',
          '#ifdef USE_INSTANCING',
          '  mvPosition = instanceMatrix * mvPosition;',
          // Eastward drift with wrap + gentle bob, derived from the
          // instance translation so the shell shader can reproduce the
          // exact same offset from its point position.
          '  float cloudDriftX = mod( instanceMatrix[3][0] + uCloudTime * '
            + DRIFT_SPEED.toFixed(1) + ' + ' + (DRIFT_RANGE / 2).toFixed(1)
            + ', ' + DRIFT_RANGE.toFixed(1) + ' ) - ' + (DRIFT_RANGE / 2).toFixed(1)
            + ' - instanceMatrix[3][0];',
          '  float cloudBobY = sin( uCloudTime * 0.08 + instanceMatrix[3][0] * 0.005'
            + ' + instanceMatrix[3][2] * 0.007 ) * 3.0;',
          '  mvPosition.x += cloudDriftX;',
          '  mvPosition.y += cloudBobY;',
          '#endif',
          'mvPosition = modelViewMatrix * mvPosition;',
          'gl_Position = projectionMatrix * mvPosition;',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform vec3 uCloudSunDir;',
          'varying float vCloudLocalY;',
          'varying vec3 vCloudNormalW;',
          'varying vec3 vCloudWorldPos;',
          'vec3 gCloudGrad;', // set in color_fragment, read by emissive below
          'float gCloudY;',
          'float gCloudFres;',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '{',
          '  float gy = clamp( vCloudLocalY, -1.0, 1.0 );',
          '  gCloudY = gy;',
          '  vec3 belly = vec3( 0.46, 0.36, 0.53 );', // violet underside
          '  vec3 midTone = vec3( 1.0, 0.78, 0.68 );', // rose mid
          '  vec3 topTone = vec3( 1.15, 0.95, 0.78 );', // warm cream-pink top
          '  vec3 grad = mix( belly, midTone, smoothstep( -0.9, 0.05, gy ) );',
          '  grad = mix( grad, topTone, smoothstep( 0.05, 0.95, gy ) );',
          '  float sunAmt = max( dot( normalize( vCloudNormalW ), uCloudSunDir ), 0.0 );',
          '  grad += vec3( 1.0, 0.55, 0.28 ) * pow( sunAmt, 2.0 ) * 0.38'
            + ' * smoothstep( -0.2, 0.8, gy );', // sunset-lit east faces
          '  gCloudGrad = grad;',
          '  diffuseColor.rgb *= grad;',
          // Soft silhouette: fade alpha toward grazing angles so puff
          // rims melt into the sky instead of ending in a hard disc edge.
          '  vec3 viewDir = normalize( vViewPosition );',
          '  vec3 nView = normalize( ( viewMatrix * vec4( normalize( vCloudNormalW ), 0.0 ) ).xyz );',
          '  float fres = pow( 1.0 - abs( dot( nView, viewDir ) ), 2.2 );',
          '  gCloudFres = fres;',
          '  diffuseColor.a *= ( 1.0 - fres * 0.92 );',
          '}',
        ].join('\n'),
      )
      .replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          '{',
          // Self-illumination from the same gradient: the low sun barely
          // grazes cloud tops, so scene lights alone leave them mauve;
          // the reference cumulus glow cream-pink from within.
          '  float glowAmt = mix( 0.22, 0.62, smoothstep( -0.9, 0.9, gCloudY ) );',
          '  totalEmissiveRadiance += gCloudGrad * glowAmt;',
          // Backlit rim: clouds between camera and sun get a golden
          // fresnel edge instead of silhouetting black on the disc.
          '  vec3 toCam = normalize( cameraPosition - vCloudWorldPos );',
          '  float backlit = pow( max( dot( -toCam, uCloudSunDir ), 0.0 ), 3.0 );',
          '  totalEmissiveRadiance += vec3( 1.0, 0.58, 0.28 ) * gCloudFres * backlit * 0.9;',
          '}',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'aurora-clouds-v1';
  return material;
}

// Shell material: camera-facing Points with the lumpy puff texture,
// per-point size/colour/alpha, the same drift formula as the cores,
// and manual fog to match the scene haze.
function makeShellMaterial(texture, sharedTime) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uCloudTime: sharedTime,
      uViewportHeight: { value: 720 },
      uFogColour: { value: FOG_COLOUR },
      uFogNear: { value: FOG_NEAR },
      uFogFar: { value: FOG_FAR },
    },
    vertexShader: [
      'attribute float aSize;',
      'attribute vec3 aColour;',
      'attribute float aAlpha;',
      'uniform float uCloudTime;',
      'uniform float uViewportHeight;',
      'varying vec3 vColour;',
      'varying float vAlpha;',
      'varying float vFogDepth;',
      'void main() {',
      '  vColour = aColour;',
      '  vAlpha = aAlpha;',
      '  vec3 pos = position;',
      '  float driftX = mod( pos.x + uCloudTime * ' + DRIFT_SPEED.toFixed(1)
        + ' + ' + (DRIFT_RANGE / 2).toFixed(1) + ', ' + DRIFT_RANGE.toFixed(1)
        + ' ) - ' + (DRIFT_RANGE / 2).toFixed(1) + ' - pos.x;',
      '  pos.x += driftX;',
      '  pos.y += sin( uCloudTime * 0.08 + position.x * 0.005 + position.z * 0.007 ) * 3.0;',
      '  vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );',
      '  vFogDepth = -mvPosition.z;',
      // World-size points: px = size * proj[1][1] * (height/2) / dist.
      '  gl_PointSize = aSize * projectionMatrix[1][1] * ( uViewportHeight * 0.5 )'
        + ' / max( -mvPosition.z, 1.0 );',
      '  gl_PointSize = min( gl_PointSize, 1400.0 );',
      '  gl_Position = projectionMatrix * mvPosition;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap;',
      'uniform vec3 uFogColour;',
      'uniform float uFogNear;',
      'uniform float uFogFar;',
      'varying vec3 vColour;',
      'varying float vAlpha;',
      'varying float vFogDepth;',
      'void main() {',
      '  vec4 tex = texture2D( uMap, gl_PointCoord );',
      '  float alpha = tex.a * vAlpha;',
      '  if ( alpha < 0.004 ) discard;',
      '  vec3 colour = vColour;',
      '  float fogFactor = smoothstep( uFogNear, uFogFar, vFogDepth );',
      '  colour = mix( colour, uFogColour, fogFactor );',
      '  gl_FragColor = vec4( colour, alpha );',
      '}',
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

export function buildVolumetricClouds() {
  const group = new THREE.Group();
  group.name = 'volumetricClouds';
  const random = makeSeededRandom(20261126);
  const sharedTime = { value: 0 };

  // ---- Placement plan -------------------------------------------------
  // Layers: low scud (400–520 m), main cumulus deck (560–850 m), high
  // wisps (980–1280 m), plus 3 hero masses east near the sun. Distances
  // 1100–5400 m keep clouds clear of the flight area and inside fog.
  const cloudSpecs = [];
  const addRingClouds = (count, altMin, altMax, baseMin, baseMax, puffMin, puffMax, flat) => {
    for (let i = 0; i < count; i += 1) {
      const angle = random() * Math.PI * 2;
      const distance = 1100 + random() * 4300;
      cloudSpecs.push({
        x: Math.cos(angle) * distance,
        y: altMin + random() * (altMax - altMin),
        z: Math.sin(angle) * distance,
        baseRadius: baseMin + random() * (baseMax - baseMin),
        puffCount: puffMin + Math.floor(random() * (puffMax - puffMin + 1)),
        flat,
        hero: false,
        rotationY: random() * Math.PI * 2,
      });
    }
  };
  addRingClouds(8, 400, 520, 40, 70, 6, 8, 0.55); // low scud
  addRingClouds(24, 560, 850, 55, 100, 8, 12, 0.8); // main cumulus deck
  addRingClouds(6, 980, 1280, 90, 150, 5, 7, 0.32); // high wisps
  // Near clouds: a few closer, higher masses that loom at the frame
  // edges like the tower reference (still ≥650 m up, clear of flight).
  for (let i = 0; i < 4; i += 1) {
    const angle = random() * Math.PI * 2;
    const distance = 750 + random() * 400;
    cloudSpecs.push({
      x: Math.cos(angle) * distance,
      y: 650 + random() * 300,
      z: Math.sin(angle) * distance,
      baseRadius: 60 + random() * 50,
      puffCount: 9 + Math.floor(random() * 4),
      flat: 0.8,
      hero: false,
      rotationY: random() * Math.PI * 2,
    });
  }
  // Hero clouds: big billowing masses bracketing the sunrise azimuth
  // (atan2 of the sun direction ≈ 0.18 rad) so the sun peeks between
  // them like the tower reference.
  const sunAzimuth = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
  for (let i = 0; i < 3; i += 1) {
    const angle = sunAzimuth + (i - 1) * (0.42 + random() * 0.2);
    const distance = 2300 + random() * 1300;
    cloudSpecs.push({
      x: Math.cos(angle) * distance,
      y: 520 + random() * 220,
      z: Math.sin(angle) * distance,
      baseRadius: 110 + random() * 60,
      puffCount: 14 + Math.floor(random() * 5),
      flat: 0.85,
      hero: true,
      rotationY: random() * Math.PI * 2,
    });
  }

  // ---- Puff layout ----------------------------------------------------
  // Each cloud: one central mass + clustered satellites stacked upward
  // (tops rounder, bases wider/flatter) so the silhouette steps like a
  // real cumulus from any angle.
  const puffMatrices = [];
  const puffColours = [];
  const shellData = [[], []]; // two texture variants: {pos,size,colour,alpha}
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();
  const bellyShell = new THREE.Color(0x8a6f96);
  const topShell = new THREE.Color(0xffd7ae);

  for (const spec of cloudSpecs) {
    const cosR = Math.cos(spec.rotationY);
    const sinR = Math.sin(spec.rotationY);
    for (let p = 0; p < spec.puffCount; p += 1) {
      const isCentre = p === 0;
      const angle = random() * Math.PI * 2;
      const dist = isCentre ? 0 : spec.baseRadius * (0.35 + random() * 0.95);
      const height01 = isCentre ? 0.45 : random(); // 0 base … 1 top
      const radius = isCentre
        ? spec.baseRadius
        : spec.baseRadius * (0.42 + random() * 0.5);
      const localX = Math.cos(angle) * dist;
      const localZ = Math.sin(angle) * dist * 0.8;
      const localY = (height01 - 0.35) * spec.baseRadius * 0.75;
      // Rotate the cluster into the cloud's heading, then place in world.
      position.set(
        spec.x + localX * cosR - localZ * sinR,
        spec.y + localY,
        spec.z + localX * sinR + localZ * cosR,
      );
      const squashY = spec.flat * (0.62 + height01 * 0.38);
      scale.set(radius * 1.22, radius * squashY, radius * 1.02);
      euler.set(0, random() * Math.PI, 0);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      puffMatrices.push(matrix.clone());
      // Per-puff tint: slight brightness/warmth variation; heroes glow
      // a touch brighter toward the sun.
      const bright = 0.9 + random() * 0.16 + (spec.hero ? 0.07 : 0);
      colour.setRGB(bright * 1.02, bright * 0.99, bright * 0.96);
      puffColours.push(colour.clone());

      // Shells: one wide soft halo per puff + a smaller offset lobe on
      // most puffs, tinted by height (violet base → warm top).
      const shellTint = bellyShell.clone().lerp(topShell, 0.25 + height01 * 0.75);
      if (spec.hero) shellTint.lerp(new THREE.Color(0xffe2bd), 0.35);
      const variant = Math.floor(random() * 2);
      const isWisp = spec.flat < 0.4;
      shellData[variant].push({
        x: position.x, y: position.y, z: position.z,
        size: radius * (isWisp ? 5.2 : 2.7),
        colour: shellTint,
        alpha: isWisp ? 0.07 : 0.19 + height01 * 0.06,
      });
      if (!isWisp && random() < 0.65) {
        shellData[1 - variant].push({
          x: position.x + (random() - 0.5) * radius * 0.9,
          y: position.y + radius * 0.3,
          z: position.z + (random() - 0.5) * radius * 0.9,
          size: radius * 1.7,
          colour: shellTint.clone().lerp(topShell, 0.3),
          alpha: 0.2,
        });
      }
    }
  }

  // ---- Core instanced mesh (1 draw) -----------------------------------
  // 13×9 segments: smooth shading + fresnel fade carry the softness at
  // cloud distances (≥1100 m); keeps the instanced puff field cheap.
  const coreGeometry = new THREE.SphereGeometry(1, 13, 9);
  const coreMesh = new THREE.InstancedMesh(
    coreGeometry,
    makeCoreMaterial(sharedTime),
    puffMatrices.length,
  );
  coreMesh.name = 'cloudCores';
  coreMesh.frustumCulled = false; // instances span the whole sky
  coreMesh.renderOrder = 1;
  for (let i = 0; i < puffMatrices.length; i += 1) {
    coreMesh.setMatrixAt(i, puffMatrices[i]);
    coreMesh.setColorAt(i, puffColours[i]);
  }
  coreMesh.instanceMatrix.needsUpdate = true;
  if (coreMesh.instanceColor) coreMesh.instanceColor.needsUpdate = true;
  group.add(coreMesh);

  // ---- Shell Points (2 draws, one per texture variant) ----------------
  const shellMaterials = [];
  for (let variant = 0; variant < 2; variant += 1) {
    const points = shellData[variant];
    const positions = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    const colours = new Float32Array(points.length * 3);
    const alphas = new Float32Array(points.length);
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;
      sizes[i] = point.size;
      colours[i * 3] = point.colour.r;
      colours[i * 3 + 1] = point.colour.g;
      colours[i * 3 + 2] = point.colour.b;
      alphas[i] = point.alpha;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    const material = makeShellMaterial(makePuffTexture(7101 + variant * 131), sharedTime);
    shellMaterials.push(material);
    const shellPoints = new THREE.Points(geometry, material);
    shellPoints.name = 'cloudShells' + variant;
    shellPoints.frustumCulled = false;
    shellPoints.renderOrder = 2;
    group.add(shellPoints);
  }

  group.userData.volumetricClouds = { sharedTime, shellMaterials };
  return group;
}

// Per-frame upkeep: advance the shared drift clock and keep the shell
// point-size scale matched to the drawing buffer. No allocations.
export function updateVolumetricClouds(group, dt) {
  const state = group && group.userData ? group.userData.volumetricClouds : null;
  if (!state) return;
  state.sharedTime.value += dt;
  const height = (typeof window !== 'undefined' ? window.innerHeight : 720)
    * Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  for (const material of state.shellMaterials) {
    material.uniforms.uViewportHeight.value = height;
  }
}
