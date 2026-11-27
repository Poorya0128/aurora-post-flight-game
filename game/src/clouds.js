// clouds.js — volumetric-LOOK puffy dawn clouds (round 2 volume fix).
//
// Round 1 read as flat clip-art discs: puffs were heavily squashed
// spheres in a flat XZ ring with depthWrite off (no occlusion between
// puffs) and a plain white radial-gradient shell texture. Round 2
// rebuilds the volume to match the references (env1/env2/env8: big
// billowing cumulus, warm cream crowns, soft violet-grey bellies):
//   * fewer, larger clouds with many more puffs each, distributed in
//     a real 3D volume (wide flat base skirt + stacked tower + volume
//     fill) with wide per-puff size/rotation variance;
//   * opaque instanced cores (depthWrite ON) so front puffs occlude
//     rear ones — the occlusion is what sells volume — with a
//     fresnel rim that melts toward the peach haze instead of an
//     alpha fade, and a gently lump-displaced sphere so no silhouette
//     is a perfect disc;
//   * per-puff cluster-height shading (instanced aPuffData: height01
//     + sunSide01): warm cream tops/sun side, lavender-grey bellies,
//     fake AO at the cluster base, golden sun boost;
//   * shell sprites use a multi-lobed canvas texture with BAKED
//     internal shading (bright crown, darker violet base, eroded
//     cauliflower edge), 2–3 layered lobes per puff plus a soft
//     per-cloud belly glow, tinted by puff height.
//
// Budget: 3 draw calls total (1 instanced core mesh + 2 shell Points).
// All drift is a shader time uniform (eastward 2.2 m/s with wrap +
// gentle bob, altitude parallax — the same formula in core and shell
// shaders so halos stay glued to cores); the per-frame update only
// advances one float — zero allocations. Procedural only: fixed-seed
// placement (reproducible screenshots), canvas textures, no assets.
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

// Scene fog from render.js createRenderer (peach FogExp2) — the
// shell shader fades into the same haze manually (exp2 curve).
const FOG_COLOUR = new THREE.Color(0xf5b88a);
const FOG_DENSITY = 0.00016;

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

// Multi-lobed puff sprite with baked internal shading: ~30 overlapping
// radial-gradient lobes build an irregular cauliflower alpha (not a
// disc), a vertical source-atop gradient shades crown bright cream ->
// base violet-grey, a soft shadow crescent darkens the belly, a crown
// highlight lifts the top, and destination-out bites erode the rim so
// layered shells never stamp a circular edge. The shell shader
// multiplies texture RGB by the per-point height tint.
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
  ctx.scale(1, 0.85);
  ctx.translate(-size / 2, -size / 2);
  const lobes = 30;
  for (let i = 0; i < lobes; i += 1) {
    const angle = random() * Math.PI * 2;
    const dist = Math.pow(random(), 0.7) * 66;
    const cx = size / 2 + Math.cos(angle) * dist;
    const cy = size / 2 + Math.sin(angle) * dist * 0.8;
    const radius = 22 + random() * 52;
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
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Internal vertical shading, clipped to the puff alpha: bright warm
  // crown at the top melting to a violet-grey belly at the base.
  ctx.globalCompositeOperation = 'source-atop';
  const shade = ctx.createLinearGradient(0, size * 0.08, 0, size * 0.94);
  shade.addColorStop(0, 'rgba(255,252,244,0.95)');
  shade.addColorStop(0.42, 'rgba(238,230,240,0.55)');
  shade.addColorStop(0.78, 'rgba(176,164,205,0.72)');
  shade.addColorStop(1, 'rgba(146,134,184,0.9)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, size, size);
  // Belly shadow crescent + crown highlight for internal modelling.
  const belly = ctx.createRadialGradient(size / 2, size * 0.92, 4, size / 2, size * 0.92, 104);
  belly.addColorStop(0, 'rgba(110,98,152,0.42)');
  belly.addColorStop(1, 'rgba(110,98,152,0)');
  ctx.fillStyle = belly;
  ctx.fillRect(0, 0, size, size);
  const crown = ctx.createRadialGradient(size / 2, size * 0.3, 2, size / 2, size * 0.3, 78);
  crown.addColorStop(0, 'rgba(255,255,250,0.5)');
  crown.addColorStop(1, 'rgba(255,255,250,0)');
  ctx.fillStyle = crown;
  ctx.fillRect(0, 0, size, size);
  // Erode the rim: small bites near the edge break the disc outline.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 42; i += 1) {
    const angle = random() * Math.PI * 2;
    const dist = 84 + random() * 38;
    const cx = size / 2 + Math.cos(angle) * dist;
    const cy = size / 2 + Math.sin(angle) * dist * 0.85;
    const radius = 6 + random() * 16;
    const bite = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    bite.addColorStop(0, 'rgba(0,0,0,0.55)');
    bite.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bite;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Core material: MeshStandardMaterial (keeps scene lights + fog) with
// injected cluster-height gradient/sun/fresnel shading and shader
// drift. Round 2: OPAQUE with depthWrite on — puffs occlude each
// other like real cumulus lobes; the fresnel rim melts the diffuse
// toward the peach haze colour instead of fading alpha (an alpha
// fade with depthWrite off was what made round 1 read as flat discs).
function makeCoreMaterial(sharedTime) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffc987,
    emissiveIntensity: 0.1, // lifts shadow sides warm; gradient does the rest
    roughness: 1.0,
    metalness: 0.0,
    flatShading: false,
    transparent: false,
    depthWrite: true,
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
          'attribute vec2 aPuffData;', // x: cluster height01, y: sunSide01
          'varying float vCloudLocalY;',
          'varying vec2 vCloudPuffData;',
          'varying vec3 vCloudNormalW;',
          'varying vec3 vCloudWorldPos;',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vCloudLocalY = position.y;',
          'vCloudPuffData = aPuffData;',
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
          // exact same offset from its point position. Higher clouds
          // drift slower (parallax) — same formula in both shaders.
          '  float cloudSpeed = ' + DRIFT_SPEED.toFixed(1)
            + ' * ( 1.0 - clamp( ( instanceMatrix[3][1] - 400.0 ) / 1200.0, 0.0, 1.0 ) * 0.35 );',
          '  float cloudDriftX = mod( instanceMatrix[3][0] + uCloudTime * cloudSpeed'
            + ' + ' + (DRIFT_RANGE / 2).toFixed(1)
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
          'varying vec2 vCloudPuffData;',
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
          '  float clusterH = clamp( vCloudPuffData.x, 0.0, 1.0 );',
          '  float sunSide = clamp( vCloudPuffData.y, 0.0, 1.0 );',
          // Combined vertical shade: puff-local Y (each lobe lit from
          // its own crown) blended with cluster height (tower tops
          // brighter than the base skirt across the whole cloud).
          '  float shadeY = clamp( gy * 0.55 + ( clusterH * 2.0 - 1.0 ) * 0.65, -1.0, 1.0 );',
          '  vec3 belly = vec3( 0.60, 0.55, 0.74 );', // lavender-grey underside
          '  vec3 midTone = vec3( 0.99, 0.89, 0.83 );', // warm pale mid
          '  vec3 topTone = vec3( 1.17, 1.04, 0.87 );', // warm cream crown
          '  vec3 grad = mix( belly, midTone, smoothstep( -0.9, 0.05, shadeY ) );',
          '  grad = mix( grad, topTone, smoothstep( 0.05, 0.95, shadeY ) );',
          // Fake AO: puffs low in the cluster sit in the mass shadow.
          '  grad *= mix( 0.78, 1.06, clusterH );',
          // Sun-side puffs run warmer/brighter than shade-side puffs.
          '  grad *= mix( 0.94, 1.08, sunSide );',
          '  grad += vec3( 0.10, 0.05, -0.02 ) * sunSide * smoothstep( -0.2, 0.8, shadeY );',
          '  float sunAmt = max( dot( normalize( vCloudNormalW ), uCloudSunDir ), 0.0 );',
          '  grad += vec3( 1.0, 0.68, 0.38 ) * pow( sunAmt, 2.0 ) * 0.38'
            + ' * smoothstep( -0.2, 0.8, shadeY );', // golden-lit east faces
          '  gCloudGrad = grad;',
          '  diffuseColor.rgb *= grad;',
          // Soft silhouette without transparency: grazing rims melt
          // toward the peach haze so the opaque lobe edge dissolves
          // into the sky while depth still occludes rear puffs.
          '  vec3 viewDir = normalize( vViewPosition );',
          '  vec3 nView = normalize( ( viewMatrix * vec4( normalize( vCloudNormalW ), 0.0 ) ).xyz );',
          '  float fres = pow( 1.0 - abs( dot( nView, viewDir ) ), 2.2 );',
          '  gCloudFres = fres;',
          '  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.99, 0.84, 0.75 ), fres * 0.5 );',
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
          // the reference cumulus glow cream from within.
          '  float glowAmt = mix( 0.20, 0.60, smoothstep( -0.9, 0.9, gCloudY ) );',
          '  totalEmissiveRadiance += gCloudGrad * glowAmt;',
          // Backlit rim: clouds between camera and sun get a golden
          // fresnel edge instead of silhouetting black on the disc.
          '  vec3 toCam = normalize( cameraPosition - vCloudWorldPos );',
          '  float backlit = pow( max( dot( -toCam, uCloudSunDir ), 0.0 ), 3.0 );',
          '  totalEmissiveRadiance += vec3( 1.0, 0.70, 0.40 ) * gCloudFres * backlit * 0.85;',
          '}',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'aurora-clouds-v2';
  return material;
}

// Shell material: camera-facing Points with the internally-shaded
// puff texture (RGB multiplied by the per-point height tint), the
// same drift formula as the cores, and manual fog to match the haze.
function makeShellMaterial(texture, sharedTime) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uCloudTime: sharedTime,
      uViewportHeight: { value: 720 },
      uFogColour: { value: FOG_COLOUR },
      uFogDensity: { value: FOG_DENSITY },
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
      // Same parallax drift as the core shader (higher = slower).
      '  float cloudSpeed = ' + DRIFT_SPEED.toFixed(1)
        + ' * ( 1.0 - clamp( ( position.y - 400.0 ) / 1200.0, 0.0, 1.0 ) * 0.35 );',
      '  float driftX = mod( pos.x + uCloudTime * cloudSpeed'
        + ' + ' + (DRIFT_RANGE / 2).toFixed(1) + ', ' + DRIFT_RANGE.toFixed(1)
        + ' ) - ' + (DRIFT_RANGE / 2).toFixed(1) + ' - pos.x;',
      '  pos.x += driftX;',
      '  pos.y += sin( uCloudTime * 0.08 + position.x * 0.005 + position.z * 0.007 ) * 3.0;',
      '  vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );',
      '  vFogDepth = -mvPosition.z;',
      // World-size points: px = size * proj[1][1] * (height/2) / dist.
      '  gl_PointSize = aSize * projectionMatrix[1][1] * ( uViewportHeight * 0.5 )'
        + ' / max( -mvPosition.z, 1.0 );',
      '  gl_PointSize = min( gl_PointSize, 1600.0 );',
      '  gl_Position = projectionMatrix * mvPosition;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap;',
      'uniform vec3 uFogColour;',
      'uniform float uFogDensity;',
      'varying vec3 vColour;',
      'varying float vAlpha;',
      'varying float vFogDepth;',
      'void main() {',
      '  vec4 tex = texture2D( uMap, gl_PointCoord );',
      '  float alpha = tex.a * vAlpha;',
      '  if ( alpha < 0.004 ) discard;',
      // Texture RGB carries the baked crown->belly shading; the
      // per-point colour tints it by puff height/sun side.
      '  vec3 colour = vColour * tex.rgb * 1.18;',
      // FogExp2 curve, matching the scene fog exactly.
      '  float fogFactor = 1.0 - exp( -uFogDensity * uFogDensity * vFogDepth * vFogDepth );',
      '  colour = mix( colour, uFogColour, fogFactor );',
      '  gl_FragColor = vec4( colour, alpha );',
      '}',
    ].join('\n'),
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

// Gentle lump displacement on the shared unit sphere: no puff is a
// perfect disc/sphere silhouette. Deterministic (position-based, no
// RNG state consumed), normals recomputed once at build.
function makeLumpySphereGeometry() {
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const lump = 1
      + 0.055 * Math.sin(v.x * 4.1 + v.y * 2.3)
      + 0.045 * Math.sin(v.y * 5.2 + v.z * 3.1)
      + 0.04 * Math.sin(v.z * 4.6 + v.x * 2.7);
    v.multiplyScalar(lump);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function buildVolumetricClouds() {
  const group = new THREE.Group();
  group.name = 'volumetricClouds';
  const random = makeSeededRandom(20261126);
  const sharedTime = { value: 0 };

  // ---- Placement plan -------------------------------------------------
  // Round 2: FEWER, LARGER clouds (references show big billowing
  // masses, not a crowded field of discs). Layers: low scud
  // (400–520 m), main cumulus deck (560–850 m), high wisps
  // (980–1280 m), 2 near masses, plus 2 hero masses east near the
  // sun. Distances 1100–5400 m keep clouds clear of the flight area.
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
  addRingClouds(3, 400, 520, 70, 115, 10, 14, 0.6); // low scud
  addRingClouds(10, 560, 850, 105, 190, 20, 27, 0.95); // main cumulus deck
  addRingClouds(3, 980, 1280, 160, 240, 7, 10, 0.35); // high wisps
  // Near clouds: closer, higher masses that loom at the frame edges
  // like the references (still ≥650 m up, clear of flight).
  for (let i = 0; i < 2; i += 1) {
    const angle = random() * Math.PI * 2;
    const distance = 750 + random() * 400;
    cloudSpecs.push({
      x: Math.cos(angle) * distance,
      y: 650 + random() * 300,
      z: Math.sin(angle) * distance,
      baseRadius: 110 + random() * 50,
      puffCount: 18 + Math.floor(random() * 7),
      flat: 0.95,
      hero: false,
      rotationY: random() * Math.PI * 2,
    });
  }
  // Hero clouds: big billowing masses bracketing the sunrise azimuth
  // (atan2 of the sun direction ≈ 0.18 rad) so the sun peeks between
  // them like the references.
  const sunAzimuth = Math.atan2(SUN_DIRECTION.z, SUN_DIRECTION.x);
  for (let i = 0; i < 2; i += 1) {
    const angle = sunAzimuth + (i === 0 ? -1 : 1) * (0.42 + random() * 0.2);
    const distance = 2300 + random() * 1300;
    cloudSpecs.push({
      x: Math.cos(angle) * distance,
      y: 520 + random() * 220,
      z: Math.sin(angle) * distance,
      baseRadius: 200 + random() * 80,
      puffCount: 28 + Math.floor(random() * 9),
      flat: 1.0,
      hero: true,
      rotationY: random() * Math.PI * 2,
    });
  }

  // ---- Puff layout ----------------------------------------------------
  // Real 3D volume per cloud, three populations:
  //   base skirt (~35%): wide, flatter puffs low in the cluster;
  //   tower (~40%): puffs stacked upward, shrinking with height so
  //     the silhouette steps like a cumulus turret;
  //   volume fill (~25%): random points inside the ellipsoid so the
  //     mass has depth from every viewing angle (no flat shell).
  // Per-puff height01 + sunSide01 feed the core shader (aPuffData)
  // and the shell tints.
  const puffMatrices = [];
  const puffColours = [];
  const puffData = []; // [height01, sunSide01] per puff
  const shellData = [[], []]; // two texture variants: {pos,size,colour,alpha}
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();
  const bellyShell = new THREE.Color(0xc4bade); // soft lavender-grey (texture darkens further)
  const topShell = new THREE.Color(0xfff6e0); // warm cream
  const sunAzimuthDir = new THREE.Vector2(SUN_DIRECTION.x, SUN_DIRECTION.z).normalize();

  for (const spec of cloudSpecs) {
    const cosR = Math.cos(spec.rotationY);
    const sinR = Math.sin(spec.rotationY);
    const isWisp = spec.flat < 0.4;
    for (let p = 0; p < spec.puffCount; p += 1) {
      const frac = spec.puffCount > 1 ? p / (spec.puffCount - 1) : 0;
      let localX = 0;
      let localY = 0;
      let localZ = 0;
      let radius = spec.baseRadius;
      if (p === 0) {
        // Central mass anchoring the cluster.
        localY = spec.baseRadius * 0.08;
        radius = spec.baseRadius * (0.85 + random() * 0.2);
      } else if (frac < 0.35) {
        // Base skirt: wide ring, low and flatter.
        const angle = random() * Math.PI * 2;
        const dist = spec.baseRadius * (0.45 + random() * 0.75);
        localX = Math.cos(angle) * dist;
        localZ = Math.sin(angle) * dist * 0.82;
        localY = (random() * 0.3 - 0.18) * spec.baseRadius;
        radius = spec.baseRadius * (0.45 + random() * 0.32);
      } else if (frac < 0.75) {
        // Tower: stacked turret, radius shrinking with height.
        const h = (frac - 0.35) / 0.4; // 0..1 up the tower
        const angle = random() * Math.PI * 2;
        const dist = spec.baseRadius * (0.5 * (1 - h) + 0.08) * random();
        localX = Math.cos(angle) * dist;
        localZ = Math.sin(angle) * dist * 0.82;
        localY = (-0.05 + h * 0.95) * spec.baseRadius * (0.85 + random() * 0.3);
        radius = spec.baseRadius * (0.68 - 0.34 * h) * (0.8 + random() * 0.35);
      } else {
        // Volume fill: random point in the ellipsoid (denser centre).
        const theta = random() * Math.PI * 2;
        const phi = Math.acos(2 * random() - 1);
        const r = Math.pow(random(), 0.55);
        localX = Math.sin(phi) * Math.cos(theta) * r * spec.baseRadius * 1.05;
        localZ = Math.sin(phi) * Math.sin(theta) * r * spec.baseRadius * 0.85;
        localY = Math.cos(phi) * r * spec.baseRadius * 0.55 + spec.baseRadius * 0.18;
        radius = spec.baseRadius * (0.38 + random() * 0.4);
      }
      // Cluster height 0 (belly) .. 1 (crown) for shading.
      const height01 = THREE.MathUtils.clamp(
        0.5 + localY / (spec.baseRadius * 1.25), 0, 1,
      );
      // Sun side: horizontal offset direction vs the sun azimuth.
      const offsetLen = Math.hypot(localX, localZ);
      const sunSide01 = offsetLen > 0.001
        ? THREE.MathUtils.clamp(
          0.5 + 0.5 * ((localX / offsetLen) * sunAzimuthDir.x
            + (localZ / offsetLen) * sunAzimuthDir.y), 0, 1,
        )
        : 0.5;
      // Rotate the cluster into the cloud's heading, then place in world.
      position.set(
        spec.x + localX * cosR - localZ * sinR,
        spec.y + localY,
        spec.z + localX * sinR + localZ * cosR,
      );
      // Wide size variance, near-spherical (round 1's heavy squash
      // was the disc look): base puffs flatter, crowns rounder.
      const squashY = spec.flat * (0.72 + height01 * 0.34) * (0.88 + random() * 0.26);
      scale.set(
        radius * (0.95 + random() * 0.45),
        radius * squashY,
        radius * (0.88 + random() * 0.38),
      );
      euler.set((random() - 0.5) * 0.7, random() * Math.PI * 2, (random() - 0.5) * 0.7);
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      puffMatrices.push(matrix.clone());
      puffData.push(height01, sunSide01);
      // Per-puff tint: slight brightness/warmth variation; heroes glow
      // a touch brighter toward the sun.
      const bright = 0.9 + random() * 0.16 + (spec.hero ? 0.07 : 0);
      colour.setRGB(bright * 1.02, bright * 0.99, bright * 0.96);
      puffColours.push(colour.clone());

      // Shells: 2–3 layered lobes per puff with 3D offsets, tinted by
      // height + sun side (violet base -> warm sunlit crown). Low
      // per-shell alpha: layering builds the soft volume.
      const shellTint = bellyShell.clone().lerp(topShell, 0.2 + height01 * 0.8);
      shellTint.lerp(new THREE.Color(0xffdfae), sunSide01 * 0.22);
      if (spec.hero) shellTint.lerp(new THREE.Color(0xffe9c8), 0.3);
      const variant = Math.floor(random() * 2);
      shellData[variant].push({
        x: position.x, y: position.y, z: position.z,
        size: radius * (isWisp ? 5.2 : 2.5 + random() * 0.9),
        colour: shellTint,
        alpha: isWisp ? 0.07 : 0.10 + height01 * 0.05,
      });
      if (!isWisp) {
        shellData[1 - variant].push({
          x: position.x + (random() - 0.5) * radius * 1.1,
          y: position.y + (random() - 0.3) * radius * 0.7,
          z: position.z + (random() - 0.5) * radius * 1.1,
          size: radius * (1.4 + random() * 0.6),
          colour: shellTint.clone().lerp(topShell, 0.3),
          alpha: 0.12,
        });
        if (random() < 0.5) {
          shellData[variant].push({
            x: position.x + (random() - 0.5) * radius * 1.4,
            y: position.y - radius * 0.25,
            z: position.z + (random() - 0.5) * radius * 1.4,
            size: radius * 1.8,
            colour: shellTint.clone().lerp(bellyShell, 0.35),
            alpha: 0.09,
          });
        }
      }
    }
    // Per-cloud belly glow: one wide soft lavender shell under the
    // mass so the underside reads as shadowed volume, not a cut edge.
    const bellyVariant = Math.floor(random() * 2);
    shellData[bellyVariant].push({
      x: spec.x,
      y: spec.y - spec.baseRadius * 0.12,
      z: spec.z,
      size: spec.baseRadius * (isWisp ? 4.2 : 3.4),
      colour: bellyShell.clone().lerp(new THREE.Color(0x9d8fc4), 0.45),
      alpha: isWisp ? 0.05 : 0.10,
    });
  }

  // ---- Core instanced mesh (1 draw) -----------------------------------
  // 12×8 lumpy spheres: occlusion + gradient shading carry the volume
  // at cloud distances (≥750 m); keeps the instanced field cheap.
  const coreGeometry = makeLumpySphereGeometry();
  coreGeometry.setAttribute(
    'aPuffData',
    new THREE.InstancedBufferAttribute(new Float32Array(puffData), 2),
  );
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
