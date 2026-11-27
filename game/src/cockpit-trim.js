// cockpit-trim.js — cabin trim for the AURORA POST cockpit rebuild.
// Reference: real Sling High Wing interior (cockpit-reference-sling.jpg)
// adapted to a SINGLE centre seat: grey moulded door cards with navy
// fabric inserts, net storage pockets, cream diamond-stitched leather
// seat with blue piping, dark carpet, sidewall consoles to the panel.
//
// One job: static trim only. Returns a THREE.Group in AIRCRAFT SPACE
// (forward = -Z, panel centre (0,0.22,-0.88), pilot eye ~(0,0.78,0.43),
// side walls x=±0.62, floor y=-0.55). No update(), no state reads.
// Centre strip x∈[-0.14,0.14], z∈[-0.7,0.5] is left EMPTY for the
// Controls agent's console/stick — only tunnel cheeks (outside the
// strip), a forward hump (z<-0.7) and a rear cover (z>0.5) are built.
//
// All textures procedural canvas; all geometry primitives merged per
// material (8 draw calls). No external assets, offline.

import * as THREE from 'three';

// ---------------------------------------------------------------- helpers

function makeCanvas(width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasTexture(canvas, repeatX = 1, repeatY = 1) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

function mergeGeometries(geometries) {
  const parts = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  let vertexCount = 0;
  for (const part of parts) vertexCount += part.attributes.position.count;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  let offset = 0;
  for (const part of parts) {
    position.set(part.attributes.position.array, offset * 3);
    normal.set(part.attributes.normal.array, offset * 3);
    if (part.attributes.uv) uv.set(part.attributes.uv.array, offset * 2);
    offset += part.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return merged;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function seededRandom(seedStart) {
  let seed = seedStart >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// ---------------------------------------------------------------- textures

// Cool light-grey moulded vinyl/plastic for door cards, tunnel cheeks,
// bulkhead and seat shell (reference: grey moulded doors). The base is
// deliberately COOL grey: under the orange sunset sun (0xff9e57) a warm
// grey multiplies to brown, so the map carries a slight blue bias that
// the warm key light cancels back to neutral grey. Fine grain + faint
// horizontal moulding seams keep large flat boxes from reading as bare
// slabs at pilot distance.
function greyTexture() {
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = seededRandom(4242);
  ctx.fillStyle = '#171d24'; // E5 EXACT-TARGET v4: near-black base — card faces catch dome+cool-fill at close range and rendered pale at #242b33; this lands dark grey like the target
  ctx.fillRect(0, 0, 256, 256);
  // Soft large-scale tonal variation (moulded panels are never flat).
  for (let i = 0; i < 26; i += 1) {
    const x = random() * 256;
    const y = random() * 256;
    const r = 30 + random() * 70;
    const grad = ctx.createRadialGradient(x, y, 2, x, y, r);
    const light = random() > 0.5;
    grad.addColorStop(0, light ? 'rgba(62,73,85,0.13)' : 'rgba(5,7,9,0.24)'); // E5 v4: variation scaled to near-black base
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Fine pebbled grain.
  for (let i = 0; i < 8000; i += 1) {
    ctx.fillStyle = random() > 0.5 ? 'rgba(70,82,95,0.15)' : 'rgba(4,5,7,0.26)'; // E5 v4: grain scaled to near-black base
    ctx.fillRect(random() * 256, random() * 256, 1.4, 1.4);
  }
  // Faint horizontal moulding seams.
  ctx.strokeStyle = 'rgba(20,25,31,0.35)';
  ctx.lineWidth = 1.5;
  for (let y = 42; y < 256; y += 85) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(256, y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(66,78,90,0.11)'; // E5 v4
    ctx.beginPath();
    ctx.moveTo(0, y + 2);
    ctx.lineTo(256, y + 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(20,25,31,0.35)';
  }
  return canvasTexture(canvas, 1, 1);
}

// Navy woven fabric with horizontal stitched channels (reference door
// inserts: padded horizontal ribs over a fine mesh weave). Base lifted
// from #1e3a5f to #2a4d7d so the insert reads blue (not near-black) at
// pilot distance under warm sunset light.
function fabricTexture() {
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = seededRandom(2718);
  ctx.fillStyle = '#1a2129'; // E5 EXACT-TARGET v4: inserts read as dark shadowed panels, not blue accents (target side walls are uniform dark grey)
  ctx.fillRect(0, 0, 256, 256);
  // Weave: fine cross-hatch speckle.
  for (let i = 0; i < 5200; i += 1) {
    const light = random() > 0.5;
    ctx.fillStyle = light ? 'rgba(110,125,140,0.30)' : 'rgba(5,8,12,0.42)'; // E5: desaturated weave for dark slate
    ctx.fillRect(random() * 256, random() * 256, 2, 1.2);
  }
  // Padded channels: soft horizontal bands with stitch lines.
  const channelH = 64;
  for (let y = 0; y < 256; y += channelH) {
    const grad = ctx.createLinearGradient(0, y, 0, y + channelH);
    grad.addColorStop(0, 'rgba(0,0,0,0.46)'); // MATFIX: deeper channel valleys
    grad.addColorStop(0.45, 'rgba(120,135,150,0.20)'); // E5: muted crowns — padded read without blue pop
    grad.addColorStop(1, 'rgba(0,0,0,0.46)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, 256, channelH);
    ctx.strokeStyle = 'rgba(130,145,160,0.55)'; // E5: stitch line muted to match dark slate
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y + 3);
    ctx.lineTo(256, y + 3);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return canvasTexture(canvas, 1, 1);
}

// Black cargo net: diamond lattice over near-black backing. Lattice
// brightened (#3a3f46 -> #6a7178) so the diamond pattern reads against
// the dark backing at pilot distance instead of collapsing to black.
function netTexture() {
  const canvas = makeCanvas(256, 192);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#121419';
  ctx.fillRect(0, 0, 256, 192);
  ctx.strokeStyle = '#454d56'; // E5: lattice darkened — net reads as dark texture, not a bright pattern (target)
  ctx.lineWidth = 4;
  const step = 22;
  for (let x = -192; x < 256; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 192, 192);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 192, 0);
    ctx.lineTo(x, 192);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(110,120,130,0.45)'; // E5: lattice highlight muted
  ctx.lineWidth = 1.2;
  for (let x = -192; x < 256; x += step) {
    ctx.beginPath();
    ctx.moveTo(x - 1, 0);
    ctx.lineTo(x + 191, 192);
    ctx.stroke();
  }
  return canvasTexture(canvas, 2, 1);
}

// Dark carpet: dense speckle pile.
function carpetTexture() {
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = seededRandom(1618);
  ctx.fillStyle = '#14161a'; // E5: darker footwell carpet (target floor is near-black)
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i += 1) {
    const shade = 22 + Math.floor(random() * 30); // E5: darker pile speckle
    ctx.fillStyle = `rgb(${shade},${shade},${shade + 3})`;
    ctx.fillRect(random() * 256, random() * 256, 1.6, 1.6);
  }
  return canvasTexture(canvas, 3, 3);
}

// Cream leather with diamond quilting + contrast stitching (reference
// seats: light beige leather, diamond pattern, blue piping at edges).
function leatherTexture() {
  const canvas = makeCanvas(256, 256);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const random = seededRandom(3141);
  ctx.fillStyle = '#c9b995'; // E5: deeper cream so the just-visible lobes read as muted light edges at frame bottom (target), not bright blocks
  ctx.fillRect(0, 0, 256, 256);
  // MATFIX: per-diamond pillow shading — soft crown highlight inside
  // each quilt cell so the quilting models as padded leather at pilot
  // distance instead of flat printed lines.
  for (let cy = 0; cy < 4; cy += 1) {
    for (let cx = 0; cx < 4; cx += 1) {
      const px = cx * 64 + 32;
      const py = cy * 64 + 32;
      const pillow = ctx.createRadialGradient(px, py, 2, px, py, 34);
      pillow.addColorStop(0, 'rgba(255,252,242,0.30)'); // M1: stronger pillow modelling for 768 read
      pillow.addColorStop(0.7, 'rgba(255,252,242,0)');
      pillow.addColorStop(1, 'rgba(110,94,64,0.26)');
      ctx.fillStyle = pillow;
      ctx.fillRect(px - 34, py - 34, 68, 68);
    }
  }
  // Leather grain.
  for (let i = 0; i < 2600; i += 1) {
    ctx.fillStyle = random() > 0.5 ? 'rgba(255,250,238,0.18)' : 'rgba(110,94,64,0.18)'; // MATFIX: grain contrast up
    ctx.fillRect(random() * 256, random() * 256, 2.2, 1.4);
  }
  // Diamond quilt seams (contrast raised so quilting reads at pilot
  // distance; repeat 2x2 below makes diamonds ~7 cm on the cushion).
  ctx.strokeStyle = 'rgba(78,62,38,0.92)'; // M1: seam contrast up so diamonds survive 768 shrink
  ctx.lineWidth = 3.4;
  const step = 64;
  for (let x = -256; x < 512; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 256, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 256, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  // Stitch dashes offset from each seam.
  ctx.strokeStyle = 'rgba(70,56,34,0.95)'; // M1: stitch dashes darker to match seams
  ctx.lineWidth = 1.8;
  ctx.setLineDash([5, 4]);
  for (let x = -256; x < 512; x += step) {
    ctx.beginPath();
    ctx.moveTo(x + 5, 0);
    ctx.lineTo(x + 261, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 251, 0);
    ctx.lineTo(x - 5, 256);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  return canvasTexture(canvas, 2, 2);
}

// ---------------------------------------------------------------- build

export function buildCockpitTrim() {
  const group = new THREE.Group();
  group.name = 'cockpit-trim';

  const grey = greyTexture();
  const fabric = fabricTexture();
  const net = netTexture();
  const carpet = carpetTexture();
  const leather = leatherTexture();

  // IMPORTANT: every material with a map uses color 0xffffff. Three
  // multiplies material.color by the map, so tinting a coloured map
  // double-darkens it — that was the root cause of the brown door
  // cards (warm grey 0x6b6f6a under orange sun, no map), the near-black
  // fabric/net/carpet (dark tints over dark maps) and the washed-out
  // beige seat (0xdccfb4 over #d8cbb2). Maps now carry the colour.
  // bumpMap reuses each colour canvas for cheap tactile relief under
  // the interior fill light (no extra textures, no extra draw calls).
  const greyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0.02, envMapIntensity: 0.06, // E5 v2: near-zero env + matte — walls stay dark grey, no sunset-sky wash (target)
  });
  if (grey) { greyMaterial.map = grey; greyMaterial.bumpMap = grey; greyMaterial.bumpScale = 0.07; } // MATFIX: deeper pebble relief
  const fabricMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.96, metalness: 0.0, envMapIntensity: 0.16, // E5: dark slate inserts stay shadowed
  });
  if (fabric) { fabricMaterial.map = fabric; fabricMaterial.bumpMap = fabric; fabricMaterial.bumpScale = 0.07; } // MATFIX: channel relief reads
  const netMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.18, // E5: net stays dark texture
  });
  if (net) { netMaterial.map = net; netMaterial.bumpMap = net; netMaterial.bumpScale = 0.06; }
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x17191d, roughness: 0.9, metalness: 0.04, envMapIntensity: 0.07, // E5 v2: tunnel/pads near-black; low env kills pink sky streak on sill tops
  });
  const carpetMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0,
  });
  if (carpet) { carpetMaterial.map = carpet; carpetMaterial.bumpMap = carpet; carpetMaterial.bumpScale = 0.05; } // MATFIX: pile relief (was flat)
  const leatherMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.68, metalness: 0.0, envMapIntensity: 0.24, // E5: muted cream — lobes read as soft light edges, no blow-out
  });
  if (leather) { leatherMaterial.map = leather; leatherMaterial.bumpMap = leather; leatherMaterial.bumpScale = 0.09; } // M1: quilt relief reads at pilot distance + 768
  const pipingMaterial = new THREE.MeshStandardMaterial({
    color: 0x39566e, roughness: 0.6, metalness: 0.0, envMapIntensity: 0.2, // E5: muted slate piping — a shadow line, not a bright blue accent (target shows none)
  });
  const metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a8f94, roughness: 0.35, metalness: 0.75,
  });

  const greyParts = [];
  const fabricParts = [];
  const netParts = [];
  const darkParts = [];
  const leatherParts = [];
  const pipingParts = [];
  const metalParts = [];

  // ---- Floor: dark carpet, full cabin width, panel to behind seat ----
  const floor = new THREE.Mesh(
    box(1.24, 0.03, 1.7, 0, -0.565, -0.05),
    carpetMaterial,
  );
  floor.name = 'trim-carpet-floor';
  group.add(floor);

  // ---- Centre tunnel: cheeks OUTSIDE the reserved strip + covers ----
  // Reserved for Controls: x∈[-0.14,0.14], z∈[-0.7,0.5] — untouched.
  for (const side of [-1, 1]) {
    // Console cheeks: taller + dark top pads so the tunnel reads as the
    // reference centre console flanking the Controls console block
    // (inner face x=±0.17 clears its x∈[-0.16,0.16] top plate).
    darkParts.push(box(0.08, 0.30, 0.90, side * 0.21, -0.40, -0.23)); // E5: cheeks DARK — target centre tunnel is a dark block between the yokes
    darkParts.push(box(0.08, 0.02, 0.90, side * 0.21, -0.24, -0.23)); // cheek top pads
  }
  darkParts.push(box(0.34, 0.24, 0.18, 0, -0.43, -0.82)); // E5: forward hump dark (z<-0.7)
  darkParts.push(box(0.34, 0.16, 0.3, 0, -0.47, 0.68)); // E5: rear tunnel cover dark (z>0.5)
  darkParts.push(box(0.3, 0.03, 0.26, 0, -0.385, 0.68)); // rear cover top pad

  // ---- Doors + lower sidewalls, both sides (mirrored) ----
  // Slimmed moulded cards (fix pass): thinner card, lower sill, shorter
  // forward reach and a narrower armrest pulled rearward, so the cards
  // frame the pilot view at the edges instead of intruding as pale
  // blocks into the forward sight lines. Layered like the reference:
  // grey shoulder + sill, blue diagonal insert, net pocket low-forward.
  for (const side of [-1, 1]) {
    const wallX = side * 0.62; // cabin side wall plane
    const tilt = side * 0.08; // door card leans slightly outward at top

    // Grey moulded door card: slim shell below the window sill.
    // E5 EXACT-TARGET v3: card top y≈0.12 / sill top y≈0.145 sits
    // just under the cabin door-glass bottom (y 0.15, aircraft.js
    // cabin build) so the glass goes LOW like the target, AND the
    // dark card covers the pale interiorWall band (x ±0.74, top
    // y 0.175) that otherwise dominates the side view. Card also
    // extended forward (z to -0.8) to cover the wall's forward run.
    greyParts.push(box(0.03, 0.67, 1.4, wallX, -0.215, -0.1, 0, 0, tilt));
    // Moulded shoulder strip along the upper card (stepped relief).
    greyParts.push(box(0.045, 0.14, 1.35, side * 0.612, 0.0, -0.08, 0, 0, tilt));
    // Sill cap along the top of the door card (E5 v3: top y≈0.145,
    // just under the cabin glass bottom — low sill like target).
    darkParts.push(box(0.08, 0.05, 1.4, side * 0.60, 0.12, -0.1, 0, 0, tilt));
    // Armrest ledge: narrow padded shelf below the shoulder.
    greyParts.push(box(0.07, 0.045, 0.62, side * 0.585, -0.16, 0.02));
    darkParts.push(box(0.065, 0.018, 0.60, side * 0.585, -0.1285, 0.02)); // armrest top pad
    // Lower door kick panel below the net pocket (E5 v3: extended
    // forward with the card to cover the wall's low forward run).
    greyParts.push(box(0.025, 0.14, 1.35, side * 0.605, -0.48, -0.08));

    // Fabric insert: diagonal padded panel below the armrest
    // (E5: now dark slate — reads as shadowed panel, not blue).
    fabricParts.push(box(0.025, 0.28, 0.62, side * 0.585, -0.34, -0.24, 0.18, 0, tilt));

    // Door handle recess + pull handle (on the shoulder strip).
    darkParts.push(box(0.02, 0.08, 0.22, side * 0.60, 0.0, 0.05));
    metalParts.push(box(0.025, 0.022, 0.14, side * 0.59, 0.005, 0.05));
    // Lower door pull (reference has a second grab low on the card).
    darkParts.push(box(0.02, 0.07, 0.2, side * 0.60, -0.32, 0.30));
    metalParts.push(box(0.025, 0.02, 0.13, side * 0.59, -0.32, 0.30));

    // Storage NET pocket: slim net panel low-forward on the door,
    // with a dark elastic top band.
    netParts.push(box(0.015, 0.16, 0.55, side * 0.60, -0.44, -0.28, 0, 0, side * -0.06));
    darkParts.push(box(0.025, 0.03, 0.57, side * 0.595, -0.345, -0.28)); // net top band

    // Lower sidewall / console wedge running forward to the panel:
    // slimmed + lowered so it stays out of the forward sight lines.
    greyParts.push(box(0.06, 0.26, 0.44, side * 0.57, -0.42, -0.60, 0, side * 0.06, 0)); // E5 v3: narrowed/inboard so it clears the forward-extended door card (inner face 0.605)
    darkParts.push(box(0.065, 0.025, 0.46, side * 0.57, -0.28, -0.60, 0, side * 0.06, 0)); // wedge top pad
  }

  // ---- Rear bulkhead behind the seat ----
  greyParts.push(box(1.24, 1.0, 0.05, 0, -0.05, 0.82));
  fabricParts.push(box(0.7, 0.4, 0.02, 0, 0.1, 0.79)); // rear fabric panel

  // ---- ONE cream leather seat, centre (x=0, z≈0.35) ----
  // Fix pass: cushion raised + widened with two forward thigh lobes
  // flanking the Controls console (centre notch like the reference
  // seats' stick cutout), so cream leather + blue piping read at the
  // bottom of the pilot frame either side of the console.
  leatherParts.push(box(0.66, 0.14, 0.42, 0, -0.13, 0.41)); // main cushion (top y=-0.06)
  leatherParts.push(box(0.58, 0.05, 0.30, 0, -0.06, 0.45)); // E5: cushion crown lowered (top y=-0.035) — seat stays below frame
  // Forward thigh lobes either side of the console (inner face x=±0.17
  // clears the console top plate x∈[-0.16,0.16]).
  // E5 EXACT-TARGET: lobes lowered (top y≈-0.045) and fronts pulled
  // back to z≈-0.22 so only the lobe tips peek at the frame bottom
  // flanking the console, like the target — no intrusion into the
  // panel/console read. Lobe bottom y≈-0.175 stays above the dark
  // tunnel cheeks (top y=-0.25): no overlap.
  leatherParts.push(box(0.17, 0.13, 0.50, -0.255, -0.11, 0.03, 0.08, 0, 0));
  leatherParts.push(box(0.17, 0.13, 0.50, 0.255, -0.11, 0.03, 0.08, 0, 0));
  // Outer bolsters on the lobes + rear cushion bolsters.
  leatherParts.push(box(0.07, 0.10, 0.44, -0.305, -0.06, 0.04, 0.08, 0, 0));
  leatherParts.push(box(0.07, 0.10, 0.44, 0.305, -0.06, 0.04, 0.08, 0, 0));
  leatherParts.push(box(0.08, 0.09, 0.36, -0.29, -0.05, 0.42));
  leatherParts.push(box(0.08, 0.09, 0.36, 0.29, -0.05, 0.42));
  // Backrest: tilted back, behind the eye (z≈0.62..0.7), top y≈0.62.
  leatherParts.push(box(0.60, 0.78, 0.13, 0, 0.22, 0.66, -0.16, 0, 0));
  // Backrest side bolsters.
  leatherParts.push(box(0.1, 0.6, 0.16, -0.28, 0.2, 0.63, -0.16, 0, 0));
  leatherParts.push(box(0.1, 0.6, 0.16, 0.28, 0.2, 0.63, -0.16, 0, 0));
  // Headrest.
  leatherParts.push(box(0.3, 0.16, 0.11, 0, 0.66, 0.72, -0.16, 0, 0));
  // Seat shell back + pan + pedestal legs + rails.
  greyParts.push(box(0.62, 0.8, 0.04, 0, 0.22, 0.745, -0.16, 0, 0));
  darkParts.push(box(0.62, 0.08, 0.52, 0, -0.245, 0.40)); // seat pan under cushion
  darkParts.push(box(0.08, 0.30, 0.34, -0.24, -0.40, 0.40)); // pedestal legs
  darkParts.push(box(0.08, 0.30, 0.34, 0.24, -0.40, 0.40));
  metalParts.push(box(0.05, 0.03, 0.5, -0.24, -0.535, 0.38)); // rails
  metalParts.push(box(0.05, 0.03, 0.5, 0.24, -0.535, 0.38));

  // Blue piping: lobe fronts + inner/outer lobe edges (the inner runs
  // flank the console like the reference stick-notch piping), crown
  // rear/sides + backrest face.
  pipingParts.push(box(0.17, 0.03, 0.03, -0.255, -0.04, -0.215, 0.08, 0, 0)); // E5: lobe fronts follow lowered/pulled-back lobes
  pipingParts.push(box(0.17, 0.03, 0.03, 0.255, -0.04, -0.215, 0.08, 0, 0));
  pipingParts.push(box(0.03, 0.03, 0.48, -0.175, -0.04, 0.03, 0.08, 0, 0)); // lobe inner edges (console flank line)
  pipingParts.push(box(0.03, 0.03, 0.48, 0.175, -0.04, 0.03, 0.08, 0, 0));
  pipingParts.push(box(0.03, 0.03, 0.48, -0.335, -0.04, 0.03, 0.08, 0, 0)); // lobe outer edges
  pipingParts.push(box(0.03, 0.03, 0.48, 0.335, -0.04, 0.03, 0.08, 0, 0));
  pipingParts.push(box(0.6, 0.02, 0.02, 0, -0.03, 0.595)); // crown rear (E5: follows lowered crown)
  pipingParts.push(box(0.02, 0.02, 0.3, -0.295, -0.03, 0.45)); // crown sides
  pipingParts.push(box(0.02, 0.02, 0.3, 0.295, -0.03, 0.45));
  pipingParts.push(box(0.56, 0.018, 0.018, 0, 0.55, 0.575, -0.16, 0, 0)); // backrest top
  pipingParts.push(box(0.018, 0.68, 0.018, -0.285, 0.22, 0.595, -0.16, 0, 0)); // backrest sides
  pipingParts.push(box(0.018, 0.68, 0.018, 0.285, 0.22, 0.595, -0.16, 0, 0));

  // ---- Merge per material: 7 meshes + floor = 8 draw calls ----
  const addMerged = (parts, material, name) => {
    if (!parts.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    mesh.name = name;
    group.add(mesh);
  };
  addMerged(greyParts, greyMaterial, 'trim-grey-moulded');
  addMerged(fabricParts, fabricMaterial, 'trim-blue-fabric');
  addMerged(netParts, netMaterial, 'trim-net-pockets');
  addMerged(darkParts, darkMaterial, 'trim-dark-pads');
  addMerged(leatherParts, leatherMaterial, 'trim-seat-leather');
  addMerged(pipingParts, pipingMaterial, 'trim-seat-piping');
  addMerged(metalParts, metalMaterial, 'trim-metal');

  group.traverse((object) => { if (object.isMesh) object.castShadow = false; });
  return group;
}
