// lens-flare.js — dawn-sun lens flare painted on the HUD stage.
//
// When the sun sits in or near the frame this lays a soft halo and a
// horizontal streak on the sun's screen position, plus a chain of
// tinted ghost discs/rings strung along the line from the sun through
// the screen centre. Everything fades as the sun leaves the frame,
// and the ghosts strengthen as it nears centre. Read-only: it pulls
// the camera and sun direction from camera-link.js, renders under
// every HUD panel, and hides itself while menus are up.

import { cameraLink } from './camera-link.js';

const STAGE_W = 1280;
const STAGE_H = 720;
const FAR = 10000; // park the virtual sun this far along its direction

// Ghost chain, golden-hour tints only (gold / peach / rose — cooler
// hues fought the warm sky). Kept gentle: peaks softened for the
// golden-hour grade so the flare whispers instead of shouting.
// `at` is the fraction along the sun->centre line (1 = centre),
// `size` is stage px.
const GHOST_SPECS = [
  { at: 0.42, size: 46, rgb: '255,217,138', peak: 0.14, ring: false },
  { at: 0.72, size: 22, rgb: '255,192,150', peak: 0.12, ring: false },
  { at: 1.18, size: 90, rgb: '255,179,150', peak: 0.08, ring: true },
  { at: 1.45, size: 34, rgb: '255,179,128', peak: 0.14, ring: false },
  { at: 1.9, size: 140, rgb: '255,217,138', peak: 0.05, ring: true },
];

const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const place = (el, x, y) => {
  el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
};

/** Create the flare layer as the stage's first child (panels paint over it). */
export function createLensFlare(stage) {
  const layer = document.createElement('div');
  layer.id = 'hud-lens-flare';
  layer.className = 'hud-flight-only';

  const glow = document.createElement('div');
  glow.className = 'flare-glow';
  layer.appendChild(glow);

  const streak = document.createElement('div');
  streak.className = 'flare-streak';
  layer.appendChild(streak);

  const ghosts = GHOST_SPECS.map((spec) => {
    const el = document.createElement('div');
    el.className = spec.ring ? 'flare-ghost flare-ring' : 'flare-ghost';
    el.style.width = `${spec.size}px`;
    el.style.height = `${spec.size}px`;
    el.style.marginLeft = `${-spec.size / 2}px`;
    el.style.marginTop = `${-spec.size / 2}px`;
    if (typeof el.style.setProperty === 'function') el.style.setProperty('--flare-rgb', spec.rgb);
    layer.appendChild(el);
    return { el, spec };
  });

  if (stage.firstChild) stage.insertBefore(layer, stage.firstChild);
  else stage.appendChild(layer);

  let drawnKey = '';

  function hide() {
    if (layer.style.display !== 'none') layer.style.display = 'none';
    drawnKey = '';
  }

  function update() {
    const cam = cameraLink.camera;
    const sun = cameraLink.sunDirection;
    if (!cam || !sun || !cam.matrixWorldInverse || !cam.projectionMatrix) return hide();

    // Project a point far along the sun direction: world -> view -> clip.
    const px = cam.position.x + sun.x * FAR;
    const py = cam.position.y + sun.y * FAR;
    const pz = cam.position.z + sun.z * FAR;
    const v = cam.matrixWorldInverse.elements;
    const vx = v[0] * px + v[4] * py + v[8] * pz + v[12];
    const vy = v[1] * px + v[5] * py + v[9] * pz + v[13];
    const vz = v[2] * px + v[6] * py + v[10] * pz + v[14];
    if (vz > -1) return hide(); // sun behind the camera

    const p = cam.projectionMatrix.elements;
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    const ndcX = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / cw;
    const ndcY = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / cw;

    // Fade out as the sun approaches and crosses the frame edge.
    const edge = Math.max(Math.abs(ndcX), Math.abs(ndcY));
    const strength = sat((1.25 - edge) / 0.45);
    if (strength <= 0.01) return hide();

    // NDC -> window px -> stage px, undoing the stage's fit-and-centre
    // scaling exactly as the HUD does it.
    const winW = window.innerWidth || STAGE_W;
    const winH = window.innerHeight || STAGE_H;
    const scale = Math.min(winW / STAGE_W, winH / STAGE_H) || 1;
    const sunX = (((ndcX + 1) / 2) * winW - (winW - STAGE_W * scale) / 2) / scale;
    const sunY = (((1 - ndcY) / 2) * winH - (winH - STAGE_H * scale) / 2) / scale;

    const key = `${Math.round(sunX)},${Math.round(sunY)},${Math.round(strength * 50)}`;
    if (key === drawnKey) return;
    drawnKey = key;
    if (layer.style.display !== '') layer.style.display = '';

    place(glow, sunX, sunY);
    glow.style.opacity = (0.65 * strength).toFixed(3);
    place(streak, sunX, sunY);
    streak.style.opacity = (0.3 * strength).toFixed(3);

    const midX = STAGE_W / 2;
    const midY = STAGE_H / 2;
    const centred = sat(1 - Math.hypot(ndcX, ndcY) / 1.4);
    for (const { el, spec } of ghosts) {
      place(el, sunX + (midX - sunX) * spec.at, sunY + (midY - sunY) * spec.at);
      el.style.opacity = (spec.peak * strength * (0.45 + 0.55 * centred)).toFixed(3);
    }
  }

  return { update, hide };
}
