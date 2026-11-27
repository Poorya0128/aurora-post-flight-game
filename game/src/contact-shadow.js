// contact-shadow.js — fake-AO contact grounding + aircraft ground blob
// (VD6-SHADOW, V6 shadow/contact pass).
//
// Why this exists: the dawn sun sits at 9°, so a real cast shadow lands
// ~6.3× the object's height to the west. The single 4096² shadow map
// (render.js) draws those long rakes near the aircraft, but PCF-soft
// edges + normal bias leave bases looking detached ("floating props"),
// and the aircraft's true ground shadow at altitude lands hundreds of
// metres west — outside the shadow frustum and off-frame in chase view.
// This module adds cheap, always-on grounding that matches the user's
// references (chase-reference.jpg / tower-reference.jpg):
//   1. One instanced radial-gradient AO blob under every shadow-casting
//      world prop / tree / building, elongated along the sun azimuth so
//      it reads as contact darkening raking west with the real shadow.
//   2. One dynamic blob tracking the aircraft's ground position with a
//      clamped westward offset, growing and fading with altitude, so the
//      plane keeps a readable ground shadow in chase view at any height.
// Cost: +2 draw calls, one 128² canvas texture, zero assets. Logic is
// untouched — this only reads the built world and the plane pose.
//
// Wiring: render.js lazy-builds this on the first updateSky() call (the
// world exists by then) and updates the aircraft blob per frame.

import * as THREE from 'three';
import { heightAt, SEA_LEVEL } from './world.js';

// Dressing modules parent outside the world group (hangar-detail and
// airfield-dressing add straight to the scene), so blobs are collected
// scene-wide, pruning the aircraft and sky subtrees by name.
const SKIP_SUBTREE_NAMES = new Set([
  'aircraft-exterior',
  'aircraft-cockpit',
  'dawnSkyDome',
  'dawnClouds',
  'sunGlow',
  'contact-shadows',
]);
const MAX_BLOBS = 6000;
const MAX_INSTANCES_PER_MESH = 2500;
const BLOB_OPACITY = 0.42;
// Objects whose base floats more than this above the ground (turbine
// rotors, rings, beacons) get no contact blob — they have no contact.
const FLOAT_GUARD_METRES = 6;
// Aircraft blob: stylised ground shadow. The physical offset would be
// AGL × 6.3 (9° sun); clamped so the shadow stays readable near the
// ground track in chase view instead of landing off-frame.
const AIRCRAFT_OFFSET_PER_AGL = 0.55;
const AIRCRAFT_OFFSET_MAX = 46;
const AIRCRAFT_BASE_WIDTH = 12; // ~wingspan, metres
const AIRCRAFT_BASE_LENGTH = 9; // ~fuselage length, metres
const AIRCRAFT_MAX_AGL = 260;

function makeBlobTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(14, 9, 6, 0.88)');
  gradient.addColorStop(0.55, 'rgba(14, 9, 6, 0.55)');
  gradient.addColorStop(0.82, 'rgba(14, 9, 6, 0.22)');
  gradient.addColorStop(1, 'rgba(14, 9, 6, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function groundYAt(x, z) {
  return Math.max(heightAt(x, z), SEA_LEVEL);
}

// Exported for render.js (VD6-SHADOW): the shadow frustum scales with
// height above ground, and the ground query lives here with heightAt.
export function groundHeightAt(x, z) {
  return groundYAt(x, z);
}

// One blob record: centre on the ground, width across the shadow
// direction, length along it. `shadowDir` is the unit ground-plane
// direction shadows fall toward (west-ish at dawn).
function makeBlobRecord(centreX, centreZ, footprintX, footprintZ, objectHeight, shadowDir) {
  const across = Math.max(footprintX, footprintZ);
  const width = THREE.MathUtils.clamp(across * 1.18 + 0.6, 1.2, 60);
  // Taller objects rake longer: elongation 1.35× (crates) → 2.4× (tower).
  const elongation = THREE.MathUtils.clamp(1.35 + objectHeight * 0.06, 1.35, 2.4);
  const length = width * elongation;
  // Hug the base, rake west: shift the centre a third of the extra
  // length along the shadow direction.
  const shift = (length - width) * 0.32;
  return {
    x: centreX + shadowDir.x * shift,
    z: centreZ + shadowDir.z * shift,
    y: groundYAt(centreX, centreZ) + 0.09,
    width,
    length,
    area: width * length,
  };
}

function collectBlobs(scene, shadowDir) {
  const blobs = [];
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4();
  const instancePos = new THREE.Vector3();
  const instanceQuat = new THREE.Quaternion();
  const instanceScale = new THREE.Vector3();

  scene.updateMatrixWorld(true);
  // Manual stack walk so named subtrees (aircraft, sky, clouds) prune
  // cleanly — THREE's traverse cannot skip children.
  const stack = [...scene.children];
  while (stack.length > 0) {
    const object = stack.pop();
    if (SKIP_SUBTREE_NAMES.has(object.name)) continue;
    for (const child of object.children) stack.push(child);
    if (blobs.length >= MAX_BLOBS) continue;
    if (!object.castShadow) continue;
    if (object.material && object.material.transparent) continue;

    if (object.isInstancedMesh) {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const geoBox = object.geometry.boundingBox;
      const geoSize = new THREE.Vector3();
      geoBox.getSize(geoSize);
      const count = Math.min(object.count, MAX_INSTANCES_PER_MESH);
      for (let i = 0; i < count && blobs.length < MAX_BLOBS; i += 1) {
        object.getMatrixAt(i, instanceMatrix);
        instanceMatrix.premultiply(object.matrixWorld);
        instanceMatrix.decompose(instancePos, instanceQuat, instanceScale);
        const footprintX = Math.abs(geoSize.x * instanceScale.x);
        const footprintZ = Math.abs(geoSize.z * instanceScale.z);
        const objectHeight = Math.abs(geoSize.y * instanceScale.y);
        const baseY = instancePos.y + geoBox.min.y * instanceScale.y;
        if (baseY - groundYAt(instancePos.x, instancePos.z) > FLOAT_GUARD_METRES) continue;
        blobs.push(makeBlobRecord(
          instancePos.x, instancePos.z, footprintX, footprintZ, objectHeight, shadowDir,
        ));
      }
      continue;
    }

    if (!object.isMesh) continue;
    box.setFromObject(object);
    if (box.isEmpty()) continue;
    box.getSize(size);
    box.getCenter(centre);
    if (box.min.y - groundYAt(centre.x, centre.z) > FLOAT_GUARD_METRES) continue;
    blobs.push(makeBlobRecord(centre.x, centre.z, size.x, size.z, size.y, shadowDir));
  }

  // Dedupe near-identical small blobs (e.g. trunk + foliage instances of
  // the same tree): keep the largest blob per 2.5 m cell. Building-scale
  // blobs (width > 9 m) always survive — they are the grounding anchors.
  const cellBest = new Map();
  const kept = [];
  for (const blob of blobs) {
    if (blob.width > 9) {
      kept.push(blob);
      continue;
    }
    const key = `${Math.round(blob.x / 2.5)},${Math.round(blob.z / 2.5)}`;
    const existing = cellBest.get(key);
    if (!existing || blob.area > existing.area) cellBest.set(key, blob);
  }
  for (const blob of cellBest.values()) kept.push(blob);
  return kept;
}

export function buildContactShadows(scene, sunDirection) {
  if (!scene || !scene.children || scene.children.length === 0) return null;

  // Ground-plane shadow direction: opposite the sun's horizontal bearing.
  const shadowDir = new THREE.Vector3(-sunDirection.x, 0, -sunDirection.z).normalize();
  const shadowAzimuth = Math.atan2(shadowDir.x, shadowDir.z);

  const texture = makeBlobTexture();
  const group = new THREE.Group();
  group.name = 'contact-shadows';

  // --- Static prop/tree/building blobs: ONE InstancedMesh, 1 draw call.
  const blobs = collectBlobs(scene, shadowDir);
  const blobGeometry = new THREE.PlaneGeometry(1, 1);
  blobGeometry.rotateX(-Math.PI / 2);
  const blobMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: BLOB_OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const blobMesh = new THREE.InstancedMesh(blobGeometry, blobMaterial, Math.max(blobs.length, 1));
  blobMesh.name = 'contact-ao-blobs';
  blobMesh.count = blobs.length;
  blobMesh.frustumCulled = false;
  blobMesh.renderOrder = 1;
  blobMesh.castShadow = false;
  blobMesh.receiveShadow = false;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, shadowAzimuth, 0));
  const scale = new THREE.Vector3();
  for (let i = 0; i < blobs.length; i += 1) {
    const blob = blobs[i];
    position.set(blob.x, blob.y, blob.z);
    scale.set(blob.width, 1, blob.length);
    matrix.compose(position, quaternion, scale);
    blobMesh.setMatrixAt(i, matrix);
  }
  blobMesh.instanceMatrix.needsUpdate = true;
  group.add(blobMesh);

  // --- Dynamic aircraft ground blob: 1 draw call, updated per frame.
  const aircraftMaterial = blobMaterial.clone();
  aircraftMaterial.opacity = 0.5;
  const aircraftBlob = new THREE.Mesh(blobGeometry, aircraftMaterial);
  aircraftBlob.name = 'aircraft-ground-blob';
  aircraftBlob.frustumCulled = false;
  aircraftBlob.renderOrder = 1;
  aircraftBlob.castShadow = false;
  aircraftBlob.receiveShadow = false;
  group.add(aircraftBlob);

  scene.add(group);
  return { group, blobMesh, aircraftBlob, shadowDir, blobCount: blobs.length };
}

const _euler = new THREE.Euler();

export function updateContactShadows(state, plane) {
  if (!state || !plane || !plane.position) return;
  const blob = state.aircraftBlob;
  const groundY = groundYAt(plane.position.x, plane.position.z);
  const agl = plane.position.y - groundY;
  if (agl > AIRCRAFT_MAX_AGL || agl < -2) {
    blob.visible = false;
    return;
  }
  blob.visible = true;
  const offset = Math.min(Math.max(agl, 0) * AIRCRAFT_OFFSET_PER_AGL, AIRCRAFT_OFFSET_MAX);
  blob.position.set(
    plane.position.x + state.shadowDir.x * offset,
    groundY + 0.1,
    plane.position.z + state.shadowDir.z * offset,
  );
  // Align the blob with the fuselage so it reads as the plane's own
  // shadow silhouette in chase view; grow + fade with altitude like a
  // real penumbra.
  _euler.setFromQuaternion(plane.quaternion, 'YXZ');
  blob.rotation.set(0, _euler.y, 0);
  const growth = 1 + Math.min(Math.max(agl, 0), 160) * 0.006;
  blob.scale.set(AIRCRAFT_BASE_WIDTH * growth, 1, AIRCRAFT_BASE_LENGTH * growth * 1.15);
  blob.material.opacity = THREE.MathUtils.clamp(0.52 - Math.max(agl, 0) * 0.0022, 0.15, 0.52);
}
