// post.js — custom HDR bloom post-processing (VD6-POST).
// One job: make the dawn scene glow like the concept art — neon rings,
// sun disc/halo, runway lamps and emissive gauges bloom with a soft
// cinematic halo — without any EffectComposer addons (vendor/ ships
// only three.module.min.js, and downloads are banned).
//
// Pipeline (all fullscreen quads, OrthographicCamera + ShaderMaterial):
//   1. scene  -> sceneRT (full res, HalfFloat, MSAA when available)
//   2. bright-pass + downsample -> half-res target (soft-knee
//      threshold on linear HDR luminance)
//   3. downsample -> quarter res, separable 9-tap Gaussian blur there
//   4. downsample -> eighth res, blur again (wide halo tier)
//   5. composite to screen: scene + (quarter + eighth) * strength,
//      then the same ACES filmic curve + exposure the renderer uses
//      for direct renders, then linear -> sRGB. A whisper of
//      vignette finishes the cinematic grade.
// (VD6-POST perf tune: blur tiers sit at quarter/eighth res, not
// half/quarter — SwiftShader A/B showed the half-res blur pair cost
// ~1/3 more frame time for a barely tighter halo; the concept glow
// is broad anyway.)
//
// Why the composite tonemaps manually: three r170 skips tone mapping
// and output colour-space conversion when rendering into a render
// target, so sceneRT holds linear HDR. The ACES fit below is three's
// own (tonemapping_pars_fragment, Stephen Hill matrices) so lit
// materials match the direct-render look exactly; only the added
// bloom (and ShaderMaterials that never tonemapped, e.g. the sky)
// change. linearToOutputTexel is three's injected converter — using
// it keeps the output transform identical to a direct render.
//
// shots.js interplay: shots.js wraps renderer.render to lock the
// screenshot camera and count ready frames. The scene pass therefore
// goes through renderer.render (dynamic lookup — the wrapper applies
// when present), while the fullscreen passes use the raw render
// captured here at construction (main.js creates the post chain
// before the shots module loads), so they never re-trigger the lock.
//
// Failure policy: any setup or per-frame error disables the chain
// permanently and falls back to plain renderer.render. Bloom is an
// enhancement, never a frame-loop blocker.
//
// API: createPost(renderer) -> {
//   render(scene, camera),  // drop-in for renderer.render
//   setSize(w, h),          // CSS pixels; also auto-checked per frame
//   enabled,                // boolean, read every frame
//   strength,               // bloom intensity multiplier, read every frame
// }

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERTEX_SHADER = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = vec4(position.xy, 0.0, 1.0);',
  '}',
].join('\n');

// Bright-pass with 4-tap box downsample (scene is full res, target is
// half res, so bilinear alone would alias). Soft knee: pixels fade in
// between threshold-knee and threshold+knee instead of popping.
// Saturation gate (VD6-POST aircraft-ghost fix): near-grey bright
// surfaces (sun-lit cream paint) are scaled down to 0.3x so they
// barely bloom; saturated emissives (green/amber rings, sun, lamps)
// pass at full weight. The sun disc (saturation ~0.45) still passes
// ~0.85x on sheer luminance.
const BRIGHT_FRAGMENT = [
  'uniform sampler2D tScene;',
  'uniform vec2 uTexel;',
  'uniform float uThreshold;',
  'uniform float uKnee;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 colour = vec3(0.0);',
  '  colour += texture2D(tScene, vUv + uTexel * vec2(-0.5, -0.5)).rgb;',
  '  colour += texture2D(tScene, vUv + uTexel * vec2( 0.5, -0.5)).rgb;',
  '  colour += texture2D(tScene, vUv + uTexel * vec2(-0.5,  0.5)).rgb;',
  '  colour += texture2D(tScene, vUv + uTexel * vec2( 0.5,  0.5)).rgb;',
  '  colour *= 0.25;',
  '  float luminance = dot(colour, vec3(0.2126, 0.7152, 0.0722));',
  '  float soft = clamp((luminance - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);',
  '  float weight = soft * soft * (3.0 - 2.0 * soft);',
  '  float maxC = max(colour.r, max(colour.g, colour.b));',
  '  float minC = min(colour.r, min(colour.g, colour.b));',
  '  float saturation = maxC > 0.0001 ? (maxC - minC) / maxC : 0.0;',
  '  float satGate = mix(0.3, 1.0, smoothstep(0.05, 0.55, saturation));',
  '  gl_FragColor = vec4(colour * weight * satGate, 1.0);',
  '}',
].join('\n');

// Separable 9-tap Gaussian (weights sum to 1). Direction (1,0) or
// (0,1) in texel units of the SOURCE texture.
const BLUR_FRAGMENT = [
  'uniform sampler2D tSource;',
  'uniform vec2 uDirection;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 colour = texture2D(tSource, vUv).rgb * 0.227027;',
  '  colour += texture2D(tSource, vUv + uDirection * 1.384615).rgb * 0.316216;',
  '  colour += texture2D(tSource, vUv - uDirection * 1.384615).rgb * 0.316216;',
  '  colour += texture2D(tSource, vUv + uDirection * 3.230769).rgb * 0.070270;',
  '  colour += texture2D(tSource, vUv - uDirection * 3.230769).rgb * 0.070270;',
  '  gl_FragColor = vec4(colour, 1.0);',
  '}',
].join('\n');

// Plain 4-tap box downsample (half -> quarter res).
const DOWNSAMPLE_FRAGMENT = [
  'uniform sampler2D tSource;',
  'uniform vec2 uTexel;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 colour = vec3(0.0);',
  '  colour += texture2D(tSource, vUv + uTexel * vec2(-0.5, -0.5)).rgb;',
  '  colour += texture2D(tSource, vUv + uTexel * vec2( 0.5, -0.5)).rgb;',
  '  colour += texture2D(tSource, vUv + uTexel * vec2(-0.5,  0.5)).rgb;',
  '  colour += texture2D(tSource, vUv + uTexel * vec2( 0.5,  0.5)).rgb;',
  '  gl_FragColor = vec4(colour * 0.25, 1.0);',
  '}',
].join('\n');

// Composite: add bloom in linear HDR, ACES (three's exact fit), then
// linearToOutputTexel (three's injected sRGB converter). Function
// names are post-prefixed: three's fragment prefix already defines
// ACESFilmicToneMapping / RRTAndODTFit when rendering to screen, and
// a duplicate definition would fail shader compilation.
const COMPOSITE_FRAGMENT = [
  'uniform sampler2D tScene;',
  'uniform sampler2D tBloomNear;',
  'uniform sampler2D tBloomFar;',
  'uniform float uStrength;',
  'uniform float uExposure;',
  'uniform float uVignette;',
  'varying vec2 vUv;',
  'vec3 postRRTFit(vec3 v) {',
  '  vec3 a = v * (v + 0.0245786) - 0.000090537;',
  '  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;',
  '  return a / b;',
  '}',
  'vec3 postACES(vec3 colour) {',
  '  const mat3 inputMat = mat3(',
  '    vec3(0.59719, 0.07600, 0.02840),',
  '    vec3(0.35458, 0.90834, 0.13383),',
  '    vec3(0.04823, 0.01566, 0.83777));',
  '  const mat3 outputMat = mat3(',
  '    vec3( 1.60475, -0.10208, -0.00327),',
  '    vec3(-0.53108,  1.10813, -0.07276),',
  '    vec3(-0.07367, -0.00605,  1.07602));',
  '  colour *= uExposure / 0.6;',
  '  colour = inputMat * colour;',
  '  colour = postRRTFit(colour);',
  '  colour = outputMat * colour;',
  '  return clamp(colour, 0.0, 1.0);',
  '}',
  'void main() {',
  '  vec3 colour = texture2D(tScene, vUv).rgb;',
  '  vec3 bloom = texture2D(tBloomNear, vUv).rgb * 0.55',
  '             + texture2D(tBloomFar, vUv).rgb * 1.0;',
  '  colour += bloom * uStrength;',
  '  colour = postACES(colour);',
  '  vec2 centred = vUv - 0.5;',
  '  float vignette = 1.0 - uVignette * dot(centred, centred) * 2.0;',
  '  colour *= clamp(vignette, 0.0, 1.0);',
  '  gl_FragColor = linearToOutputTexel(vec4(colour, 1.0));',
  '}',
].join('\n');

// ---------------------------------------------------------------------------
// Post chain
// ---------------------------------------------------------------------------

// Defaults tuned for the dawn scene: rings/lamps/sun sit at linear
// luminance ~1.0-2.4 (emissiveIntensity 1.0-1.6, sun disc ~2.4), the
// sky horizon sits below ~0.65. VD6-POST fix (user report 2026-11-27:
// chase-view aircraft washed to a white ghost): threshold 0.85 -> 1.0
// and strength 0.85 -> 0.60, plus a saturation gate in the bright-
// pass — sun-lit cream paint is near-grey (low saturation) while
// rings/sun/lamps are saturated, so the gate keeps paint out of the
// bloom while emissives still glow.
const DEFAULT_THRESHOLD = 1.0;
const DEFAULT_KNEE = 0.3;
const DEFAULT_STRENGTH = 0.6;
// Kept faint: style.css #fx-grade already lays a CSS vignette over
// the canvas, so the composite only adds a whisper of extra falloff.
const DEFAULT_VIGNETTE = 0.08;

function makeTarget(width, height, type, samples) {
  return new THREE.WebGLRenderTarget(Math.max(width, 1), Math.max(height, 1), {
    type,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    samples: samples || 0,
  });
}

export function createPost(renderer) {
  // Raw render captured NOW, before shots.js can wrap renderer.render
  // (main.js constructs the chain right after createRenderer; the
  // shots module loads later via dynamic import). Fullscreen passes
  // use this; the scene pass uses renderer.render so the shots
  // camera lock still applies.
  const rawRender = renderer.render.bind(renderer);

  const api = {
    enabled: true,
    strength: DEFAULT_STRENGTH,
    render(scene, camera) {
      if (!state.ready || !api.enabled) {
        renderer.render(scene, camera);
        return;
      }
      try {
        renderChain(scene, camera);
      } catch (error) {
        // Never let post break a frame: disable permanently and draw
        // the scene the plain way. Restore the default target first
        // in case the failure happened mid-chain.
        state.ready = false;
        try { renderer.setRenderTarget(null); } catch (ignored) { /* noop */ }
        renderer.render(scene, camera);
      }
    },
    setSize(width, height) {
      try {
        resizeTargets(width, height);
      } catch (error) {
        state.ready = false;
      }
    },
  };

  const state = {
    ready: false,
    width: 0,
    height: 0,
    pixelRatio: 1,
    sceneTarget: null,
    halfA: null,
    quarterA: null,
    quarterB: null,
    eighthA: null,
    eighthB: null,
    quadScene: null,
    quadCamera: null,
    quadMesh: null,
    brightMaterial: null,
    blurMaterial: null,
    downsampleMaterial: null,
    compositeMaterial: null,
  };

  const drawingSize = new THREE.Vector2();

  function resizeTargets(cssWidth, cssHeight) {
    const pixelRatio = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    const width = Math.max(Math.round(cssWidth * pixelRatio), 1);
    const height = Math.max(Math.round(cssHeight * pixelRatio), 1);
    if (width === state.width && height === state.height && state.sceneTarget) return;
    state.width = width;
    state.height = height;
    state.pixelRatio = pixelRatio;

    const halfWidth = Math.max(Math.floor(width / 2), 1);
    const halfHeight = Math.max(Math.floor(height / 2), 1);
    const quarterWidth = Math.max(Math.floor(width / 4), 1);
    const quarterHeight = Math.max(Math.floor(height / 4), 1);
    const eighthWidth = Math.max(Math.floor(width / 8), 1);
    const eighthHeight = Math.max(Math.floor(height / 8), 1);

    if (!state.sceneTarget) {
      const gl = renderer.getContext();
      const floatRenderable = !!(
        gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')
      );
      const targetType = floatRenderable ? THREE.HalfFloatType : THREE.UnsignedByteType;
      const maxSamples = renderer.capabilities && renderer.capabilities.maxSamples
        ? renderer.capabilities.maxSamples : 0;
      // The canvas is antialiased; keep MSAA on the scene target so
      // edges stay as smooth as the direct render. Bloom targets are
      // blur outputs — no MSAA needed there. 2x (was 4x): the
      // SwiftShader A/B priced 4x multisample resolve too dear.
      const sceneSamples = Math.min(2, maxSamples);
      state.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
        type: targetType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        samples: sceneSamples,
      });
      state.halfA = makeTarget(halfWidth, halfHeight, targetType, 0);
      state.quarterA = makeTarget(quarterWidth, quarterHeight, targetType, 0);
      state.quarterB = makeTarget(quarterWidth, quarterHeight, targetType, 0);
      state.eighthA = makeTarget(eighthWidth, eighthHeight, targetType, 0);
      state.eighthB = makeTarget(eighthWidth, eighthHeight, targetType, 0);
    } else {
      state.sceneTarget.setSize(width, height);
      state.halfA.setSize(halfWidth, halfHeight);
      state.quarterA.setSize(quarterWidth, quarterHeight);
      state.quarterB.setSize(quarterWidth, quarterHeight);
      state.eighthA.setSize(eighthWidth, eighthHeight);
      state.eighthB.setSize(eighthWidth, eighthHeight);
    }
  }

  function runPass(material, target) {
    state.quadMesh.material = material;
    renderer.setRenderTarget(target);
    rawRender(state.quadScene, state.quadCamera);
  }

  function renderChain(scene, camera) {
    // render.js owns resize (renderer.setSize on window resize); the
    // chain follows the drawing buffer so no extra hook is needed.
    renderer.getDrawingBufferSize(drawingSize);
    if (drawingSize.x !== state.width || drawingSize.y !== state.height) {
      const ratio = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
      resizeTargets(drawingSize.x / ratio, drawingSize.y / ratio);
    }

    const halfTexelX = 1 / state.halfA.width;
    const halfTexelY = 1 / state.halfA.height;
    const quarterTexelX = 1 / state.quarterA.width;
    const quarterTexelY = 1 / state.quarterA.height;
    const eighthTexelX = 1 / state.eighthA.width;
    const eighthTexelY = 1 / state.eighthA.height;

    // 1) Scene -> HDR target. Via renderer.render (dynamic) so the
    // shots.js camera lock + ready-frame counting still apply.
    renderer.setRenderTarget(state.sceneTarget);
    renderer.render(scene, camera);

    // 2) Bright-pass + downsample to half res.
    const bright = state.brightMaterial.uniforms;
    bright.tScene.value = state.sceneTarget.texture;
    bright.uTexel.value.set(1 / state.width, 1 / state.height);
    runPass(state.brightMaterial, state.halfA);

    // 3) Downsample to quarter res, separable blur there (A -> B -> A).
    const down = state.downsampleMaterial.uniforms;
    down.tSource.value = state.halfA.texture;
    down.uTexel.value.set(halfTexelX, halfTexelY);
    runPass(state.downsampleMaterial, state.quarterA);
    const blur = state.blurMaterial.uniforms;
    blur.tSource.value = state.quarterA.texture;
    blur.uDirection.value.set(quarterTexelX, 0);
    runPass(state.blurMaterial, state.quarterB);
    blur.tSource.value = state.quarterB.texture;
    blur.uDirection.value.set(0, quarterTexelY);
    runPass(state.blurMaterial, state.quarterA);

    // 4) Downsample to eighth res, blur again (wide halo tier).
    down.tSource.value = state.quarterA.texture;
    down.uTexel.value.set(quarterTexelX, quarterTexelY);
    runPass(state.downsampleMaterial, state.eighthA);
    blur.tSource.value = state.eighthA.texture;
    blur.uDirection.value.set(eighthTexelX, 0);
    runPass(state.blurMaterial, state.eighthB);
    blur.tSource.value = state.eighthB.texture;
    blur.uDirection.value.set(0, eighthTexelY);
    runPass(state.blurMaterial, state.eighthA);

    // 5) Composite to screen (ACES + sRGB + vignette).
    const composite = state.compositeMaterial.uniforms;
    composite.tScene.value = state.sceneTarget.texture;
    composite.tBloomNear.value = state.quarterA.texture;
    composite.tBloomFar.value = state.eighthA.texture;
    composite.uStrength.value = api.strength;
    composite.uExposure.value = renderer.toneMappingExposure || 1;
    runPass(state.compositeMaterial, null);
  }

  try {
    state.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    state.quadScene = new THREE.Scene();
    state.quadMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    state.quadMesh.frustumCulled = false;
    state.quadScene.add(state.quadMesh);

    const passDefaults = {
      vertexShader: VERTEX_SHADER,
      depthTest: false,
      depthWrite: false,
    };
    state.brightMaterial = new THREE.ShaderMaterial({
      ...passDefaults,
      fragmentShader: BRIGHT_FRAGMENT,
      uniforms: {
        tScene: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uThreshold: { value: DEFAULT_THRESHOLD },
        uKnee: { value: DEFAULT_KNEE },
      },
    });
    state.blurMaterial = new THREE.ShaderMaterial({
      ...passDefaults,
      fragmentShader: BLUR_FRAGMENT,
      uniforms: {
        tSource: { value: null },
        uDirection: { value: new THREE.Vector2(0, 0) },
      },
    });
    state.downsampleMaterial = new THREE.ShaderMaterial({
      ...passDefaults,
      fragmentShader: DOWNSAMPLE_FRAGMENT,
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
    });
    state.compositeMaterial = new THREE.ShaderMaterial({
      ...passDefaults,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: {
        tScene: { value: null },
        tBloomNear: { value: null },
        tBloomFar: { value: null },
        uStrength: { value: DEFAULT_STRENGTH },
        uExposure: { value: 1.15 },
        uVignette: { value: DEFAULT_VIGNETTE },
      },
    });

    renderer.getDrawingBufferSize(drawingSize);
    const ratio = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
    resizeTargets(drawingSize.x / ratio, drawingSize.y / ratio);
    state.ready = true;
  } catch (error) {
    state.ready = false;
  }

  return api;
}
