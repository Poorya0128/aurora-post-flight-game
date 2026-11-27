// camera-link.js — a tiny shared slot connecting the 3D renderer to
// the screen-space overlays. The render loop publishes its camera and
// the sun direction here once; the HUD instruments and the lens flare
// read them back when they need to project world points onto the
// 1280x720 HUD stage. Nothing else is stored.

export const cameraLink = { camera: null, sunDirection: null };

export function linkCamera(camera) {
  cameraLink.camera = camera || null;
}

export function linkSun(direction) {
  cameraLink.sunDirection = direction || null;
}
