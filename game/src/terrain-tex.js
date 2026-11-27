// terrain-tex.js — V6-TERRAIN procedural terrain surface textures.
//
// One job: generate every terrain surface texture in code (no assets),
// once at load, so the island ground reads with real surface detail at
// judge size (768x480) AND close-up, without touching terrain heights,
// logic, or draw calls. world.js (held by Agent 4 / V6-WORLD-LOOK)
// consumes this module through a minimal hook: the terrain material's
// `map`, a per-vertex atlas UV attribute in buildIslandTerrain, and the
// road texture in buildRoads.
//
// Atlas layout (1024x1024, four 512x512 tiles, each tileable):
//   tile 0 GRASS  (top-left)    blade strokes, clover flecks, soil specks
//   tile 1 DIRT   (top-right)   ploughed furrows, clumps, stubble
//   tile 2 ROCK   (bottom-left) wavy strata bands, cracks, lichen flecks
//   tile 3 SAND   (bottom-right) wind ripples, grain, shell flecks
// Tiles are modulation maps (mean ~1.0): they multiply the vertex
// colours, so the locked palette survives while the surface gains
// texture. Per-vertex UVs pick the tile by height/slope/field type and
// tile inside it every TILE_WORLD metres, so beach -> grass -> dirt ->
// rock transitions blend across one triangle instead of popping.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Deterministic helpers (self-contained; same seeded world every load)
// ---------------------------------------------------------------------------
function seededRandom(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLattice(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 974634211);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Tileable value noise: lattice indices wrap modulo `period`, so a tile
// drawn with u,v in 0..1 repeats seamlessly. Lattice values are
// precomputed into a grid once per tile (the per-pixel loop then only
// interpolates) — atlas generation stays fast on weak hardware.
function makeNoiseGrid(period, seed) {
  const grid = new Float32Array(period * period);
  for (let y = 0; y < period; y++) {
    for (let x = 0; x < period; x++) grid[y * period + x] = hashLattice(x, y, seed);
  }
  return grid;
}

function sampleGrid(grid, period, u, v) {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = grid[y0 * period + x0];
  const b = grid[y0 * period + x1];
  const c = grid[y1 * period + x0];
  const d = grid[y1 * period + x1];
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function makeCanvasTexture(width, height, drawFn) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawFn(ctx, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Terrain atlas
// ---------------------------------------------------------------------------
export const TERRAIN_TILE = { GRASS: 0, DIRT: 1, ROCK: 2, SAND: 3 };
// Metres of ground covered by one tile repeat. 30 m keeps furrows /
// ripples / strata at a believable scale from the air and still gives
// visible grain on the ground; at 768x480 the vertex-colour patchwork
// carries the read, the texture carries the close-up.
export const TILE_WORLD = 30;
const TILE_INSET = 0.008; // UV inset per tile edge — stops mip bleed

// Which atlas tile a terrain vertex samples. Mirrors the colour bands
// in world.js terrainVertexColor (same thresholds) so texture type and
// vertex colour always agree: sand at the shore, rock on steep/high
// ground, ploughed dirt in the dry-field band and on mid slopes
// (scree), grass everywhere else.
export function terrainTileIndex(height, slope, patch, detail, islandPeak) {
  if (height < 2.4) return TERRAIN_TILE.SAND;
  if (slope > 0.38 || height > islandPeak * 0.5) return TERRAIN_TILE.ROCK;
  if (slope > 0.24) return TERRAIN_TILE.DIRT;
  // Dry / harvested fields: same band the vertex colour uses for
  // COLOR_DRY_FIELD (fine detail high, primary patch mid-low).
  if (detail > 0.6 && patch < 0.55) return TERRAIN_TILE.DIRT;
  return TERRAIN_TILE.GRASS;
}

// World position -> atlas UV. `out` is a reusable [u, v] array.
export function terrainAtlasUV(x, z, tile, out) {
  const col = tile % 2;
  const row = Math.floor(tile / 2);
  let fu = (x / TILE_WORLD) % 1;
  if (fu < 0) fu += 1;
  let fv = (z / TILE_WORLD) % 1;
  if (fv < 0) fv += 1;
  const span = 0.5 - TILE_INSET * 2;
  out[0] = col * 0.5 + TILE_INSET + fu * span;
  // Canvas row 0 is the top; THREE UV v=1 is the top of the image.
  out[1] = 1 - (row * 0.5 + TILE_INSET + fv * span);
  return out;
}

function paintTileBase(ctx, ox, oy, size, tile) {
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const seed = 1000 + tile * 7919;
  const grid1 = makeNoiseGrid(6, seed);
  const grid2 = makeNoiseGrid(18, seed + 131);
  const grid3 = makeNoiseGrid(48, seed + 262);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n1 = sampleGrid(grid1, 6, u, v);
      const n2 = sampleGrid(grid2, 18, u, v);
      const n3 = sampleGrid(grid3, 48, u, v);
      const grain = hashLattice(x, y, seed + 393);
      let m = 0.8 + n1 * 0.2 + n2 * 0.13 + n3 * 0.07 + (grain - 0.5) * 0.09;
      let rMul = 1;
      let gMul = 1;
      let bMul = 1;
      if (tile === TERRAIN_TILE.GRASS) {
        // Blade-scale flecks: sparse dark/light pinpoints in the sward.
        if (grain > 0.94) m *= 0.78;
        else if (grain < 0.04) m *= 1.1;
        rMul = 0.93 + n2 * 0.1;
        bMul = 0.88 + n1 * 0.08;
      } else if (tile === TERRAIN_TILE.DIRT) {
        // Ploughed furrows: wavy rows across the tile (~14 rows per
        // 30 m repeat ≈ 2 m row spacing), crests lit, troughs shaded.
        const furrow = 0.5 + 0.5 * Math.sin((v * 14 + n1 * 1.6) * Math.PI * 2);
        m *= 0.84 + furrow * 0.2;
        if (n2 > 0.72) m *= 0.88; // soil clumps
        rMul = 1.03;
        gMul = 0.98;
        bMul = 0.9;
      } else if (tile === TERRAIN_TILE.ROCK) {
        // Strata: wavy horizontal bands with a dark seam at each join.
        const bandPos = v * 7 + n1 * 0.9;
        const band = Math.floor(bandPos) % 2 === 0 ? 1.0 : 0.88;
        m *= band;
        if (bandPos - Math.floor(bandPos) < 0.09) m *= 0.74;
        if (n3 > 0.78) m *= 0.9; // weathered pockets
        rMul = 1.01;
        bMul = 0.96;
      } else {
        // Sand ripples: diagonal wind waves + strong grain.
        const ripple = 0.5 + 0.5 * Math.sin((u * 0.6 + v) * Math.PI * 2 * 16 + n1 * 4);
        m *= 0.92 + ripple * 0.12;
        m += (grain - 0.5) * 0.06;
        rMul = 1.02;
        gMul = 1.0;
        bMul = 0.93;
      }
      const idx = (y * size + x) * 4;
      data[idx] = clamp255(m * rMul * 255);
      data[idx + 1] = clamp255(m * gMul * 255);
      data[idx + 2] = clamp255(m * bMul * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, ox, oy);
}

// Draw a small mark at its tile position, plus wrapped copies only
// when it sits near an edge, so vector detail stays seamless across
// tile edges without paying 9x draw cost for interior marks.
function wrappedMark(ctx, ox, oy, size, x, y, draw) {
  draw(ox + x, oy + y);
  const EDGE = 20;
  const xs = x < EDGE ? [size] : x > size - EDGE ? [-size] : [];
  const ys = y < EDGE ? [size] : y > size - EDGE ? [-size] : [];
  for (const dx of xs) draw(ox + x + dx, oy + y);
  for (const dy of ys) draw(ox + x, oy + y + dy);
  for (const dx of xs) for (const dy of ys) draw(ox + x + dx, oy + y + dy);
}

function paintTileDetail(ctx, ox, oy, size, tile) {
  const rng = seededRandom(5000 + tile * 104729);
  if (tile === TERRAIN_TILE.GRASS) {
    // Grass blades: short leaning strokes, dark + sunlit mix.
    for (let i = 0; i < 2600; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const lean = (rng() - 0.5) * 3;
      const len = 2 + rng() * 3.5;
      ctx.strokeStyle = rng() > 0.45 ? 'rgba(38,66,22,0.35)' : 'rgba(210,235,160,0.28)';
      ctx.lineWidth = 1;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + lean, py - len);
        ctx.stroke();
      });
    }
    // Clover / weed flecks + bare-soil specks.
    for (let i = 0; i < 500; i++) {
      const x = rng() * size;
      const y = rng() * size;
      ctx.fillStyle = rng() > 0.6 ? 'rgba(90,70,40,0.30)' : 'rgba(240,245,200,0.22)';
      const s = 1 + rng() * 2;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => ctx.fillRect(px, py, s, s));
    }
  } else if (tile === TERRAIN_TILE.DIRT) {
    // Stones + stubble on the furrows.
    for (let i = 0; i < 1400; i++) {
      const x = rng() * size;
      const y = rng() * size;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(60,48,32,0.35)' : 'rgba(235,225,200,0.30)';
      const s = 1 + rng() * 2.5;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => ctx.fillRect(px, py, s, s));
    }
    for (let i = 0; i < 700; i++) {
      const x = rng() * size;
      const y = rng() * size;
      ctx.strokeStyle = 'rgba(215,190,120,0.4)';
      ctx.lineWidth = 1;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + (rng() - 0.5) * 2, py - 2 - rng() * 2);
        ctx.stroke();
      });
    }
  } else if (tile === TERRAIN_TILE.ROCK) {
    // Cracks: short dark wandering polylines.
    for (let i = 0; i < 90; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const pts = [];
      let cx = 0;
      let cy = 0;
      for (let p = 0; p < 5; p++) {
        pts.push([cx, cy]);
        cx += (rng() - 0.5) * 14;
        cy += rng() * 10;
      }
      ctx.strokeStyle = 'rgba(28,24,20,0.45)';
      ctx.lineWidth = 1;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => {
        ctx.beginPath();
        ctx.moveTo(px + pts[0][0], py + pts[0][1]);
        for (let p = 1; p < pts.length; p++) ctx.lineTo(px + pts[p][0], py + pts[p][1]);
        ctx.stroke();
      });
    }
    // Lichen + scree flecks.
    for (let i = 0; i < 900; i++) {
      const x = rng() * size;
      const y = rng() * size;
      ctx.fillStyle = rng() > 0.75 ? 'rgba(150,160,110,0.30)' : 'rgba(20,18,16,0.28)';
      const s = 1 + rng() * 2;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => ctx.fillRect(px, py, s, s));
    }
  } else {
    // Shell / pebble flecks + darker damp patches.
    for (let i = 0; i < 1100; i++) {
      const x = rng() * size;
      const y = rng() * size;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,250,240,0.35)' : 'rgba(140,115,80,0.30)';
      const s = 1 + rng() * 1.8;
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => ctx.fillRect(px, py, s, s));
    }
    for (let i = 0; i < 26; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const rx = 14 + rng() * 30;
      const ry = 6 + rng() * 12;
      ctx.fillStyle = 'rgba(150,125,85,0.16)';
      wrappedMark(ctx, ox, oy, size, x, y, (px, py) => {
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
}

export function makeTerrainAtlasTexture() {
  const texture = makeCanvasTexture(1024, 1024, (ctx, w, h) => {
    const half = w / 2;
    for (let tile = 0; tile < 4; tile++) {
      const ox = (tile % 2) * half;
      const oy = Math.floor(tile / 2) * half;
      paintTileBase(ctx, ox, oy, half, tile);
      paintTileDetail(ctx, ox, oy, half, tile);
    }
  });
  if (texture) {
    // UVs are computed inside tiles, so clamping (not repeat) is the
    // correct wrap; mipmaps stay on for distance reads.
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return texture;
}

// ---------------------------------------------------------------------------
// Road texture v2 (256x256, one tile per 14 m of road — same UV plan as
// world.js buildRoads: canvas x = along road, canvas y = across road).
// Worn asphalt: aggregate speckle, cracks, patch seams, gravel
// shoulders, worn cream edge lines and a bold centreline dash so the
// road reads as a marked road at 768x480 and as asphalt close-up.
// ---------------------------------------------------------------------------
export function makeRoadTextureV2() {
  const texture = makeCanvasTexture(256, 256, (ctx, w, h) => {
    const rng = seededRandom(7741);
    // Asphalt base with broad tonal variation.
    ctx.fillStyle = '#4c4842';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,250,240,0.05)' : 'rgba(10,10,10,0.08)';
      ctx.beginPath();
      ctx.ellipse(rng() * w, rng() * h, 20 + rng() * 50, 8 + rng() * 20, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Aggregate speckle.
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = rng() > 0.5 ? 'rgba(255,250,240,0.10)' : 'rgba(15,14,12,0.16)';
      ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
    }
    // Gravel shoulders: paler, coarser bands at both edges.
    ctx.fillStyle = 'rgba(150,138,112,0.55)';
    ctx.fillRect(0, 0, w, 16);
    ctx.fillRect(0, h - 16, w, 16);
    for (let i = 0; i < 700; i++) {
      const y = rng() > 0.5 ? rng() * 16 : h - 16 + rng() * 16;
      ctx.fillStyle = rng() > 0.5 ? 'rgba(90,80,60,0.4)' : 'rgba(240,235,220,0.35)';
      ctx.fillRect(rng() * w, y, 2, 2);
    }
    // Cracks.
    for (let i = 0; i < 22; i++) {
      let x = rng() * w;
      let y = 20 + rng() * (h - 40);
      ctx.strokeStyle = 'rgba(18,16,14,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let p = 0; p < 4; p++) {
        x += (rng() - 0.5) * 26;
        y += (rng() - 0.5) * 14;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Worn edge lines (cream), then wear them back with asphalt flecks.
    ctx.fillStyle = '#EDE6D6';
    ctx.fillRect(0, 22, w, 8);
    ctx.fillRect(0, h - 30, w, 8);
    // Centreline dash: one long dash per tile, warm cream.
    ctx.fillStyle = '#F0E4B8';
    ctx.fillRect(26, h / 2 - 6, 120, 12);
    // Wear: asphalt-coloured flecks over the paint.
    for (let i = 0; i < 500; i++) {
      const band = rng();
      const y = band < 0.33 ? 22 + rng() * 8 : band < 0.66 ? h - 30 + rng() * 8 : h / 2 - 6 + rng() * 12;
      ctx.fillStyle = 'rgba(76,72,66,0.55)';
      ctx.fillRect(rng() * w, y, 2 + rng() * 4, 1 + rng() * 2);
    }
    // Wheel-track polish: two darker lanes where tyres run.
    ctx.fillStyle = 'rgba(20,19,17,0.10)';
    ctx.fillRect(0, h * 0.3, w, 18);
    ctx.fillRect(0, h * 0.62, w, 18);
  });
  if (texture) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return texture;
}
