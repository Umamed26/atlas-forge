/**
 * Pixel rasterizer: hypsometric tint + NW hillshade + biome wash + parchment
 * paper (grain / mottling / stains / vignette) drawn straight into ImageData.
 *
 * The terrain colour, hillshade and colour grade are baked into an albedo field
 * at simulation resolution; the per-output-pixel pass then only does bilinear
 * lookups plus cheap deterministic paper noise. This keeps a 1024² preview
 * inside its frame budget while the 4096² export gets the same look.
 *
 * Pure function of (layers, document, theme, output size): no Math.random, no
 * Date, no DOM — identical pixels in the browser and in Node, at any size.
 */
import type { WorldLayers } from "@atlas/core";
import type { ImageDataLike } from "./canvas-types";
import { fbm2, hash01, hashSigned, smoothstep, valueNoise2 } from "./noise";
import { sampleScalar } from "./sampling";
import { cssRgb, type RenderTheme, type RGB } from "./style";

export interface TerrainField {
  size: number;
  /** Interleaved RGB albedo per simulation cell (0..255 floats, hillshaded). */
  albedo: Float32Array;
  /** Distance to the nearest land/water boundary in cells (capped). */
  boundaryDist: Float32Array;
  maxDepth: number;
  maxLand: number;
}

export interface PaperTexture {
  res: number;
  /** Per-texel multiplier offset already folded with the theme amounts. */
  data: Float32Array;
}

const LUT_SIZE = 512;

function buildLandLut(theme: RenderTheme): Float32Array {
  const lut = new Float32Array(LUT_SIZE * 3);
  const stops: Array<{ at: number; color: RGB }> = [
    { at: 0, color: theme.land.low },
    { at: 0.16, color: theme.land.olive },
    { at: 0.4, color: theme.land.mid },
    { at: 0.66, color: theme.land.high },
    { at: 0.86, color: theme.land.rock },
    { at: 1, color: theme.land.peak },
  ];
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = i / (LUT_SIZE - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s += 1) {
      if (t >= stops[s].at && t <= stops[s + 1].at) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    const span = b.at - a.at || 1;
    const u = Math.min(1, Math.max(0, (t - a.at) / span));
    lut[i * 3] = a.color[0] + (b.color[0] - a.color[0]) * u;
    lut[i * 3 + 1] = a.color[1] + (b.color[1] - a.color[1]) * u;
    lut[i * 3 + 2] = a.color[2] + (b.color[2] - a.color[2]) * u;
  }
  return lut;
}

/** Two-pass chamfer distance transform (capped) seeded from boundary cells. */
function boundaryDistance(mask: Uint8Array, size: number, cap: number): Float32Array {
  const cells = size * size;
  const dist = new Float32Array(cells);
  const BIG = cap + 1;
  for (let i = 0; i < cells; i += 1) dist[i] = mask[i] ? 0 : BIG;
  const diag = Math.SQRT2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) {
        const v = dist[i - 1] + 1;
        if (v < d) d = v;
      }
      if (y > 0) {
        const up = i - size;
        const v = dist[up] + 1;
        if (v < d) d = v;
        if (x > 0) {
          const v2 = dist[up - 1] + diag;
          if (v2 < d) d = v2;
        }
        if (x < size - 1) {
          const v2 = dist[up + 1] + diag;
          if (v2 < d) d = v2;
        }
      }
      dist[i] = d < BIG ? d : BIG;
    }
  }
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = size - 1; x >= 0; x -= 1) {
      const i = y * size + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x < size - 1) {
        const v = dist[i + 1] + 1;
        if (v < d) d = v;
      }
      if (y < size - 1) {
        const down = i + size;
        const v = dist[down] + 1;
        if (v < d) d = v;
        if (x < size - 1) {
          const v2 = dist[down + 1] + diag;
          if (v2 < d) d = v2;
        }
        if (x > 0) {
          const v2 = dist[down - 1] + diag;
          if (v2 < d) d = v2;
        }
      }
      dist[i] = d < BIG ? d : BIG;
    }
  }
  for (let i = 0; i < cells; i += 1) if (dist[i] > cap) dist[i] = cap;
  return dist;
}

/** Precompute the terrain colour + hillshade field at simulation resolution. */
export function buildTerrainField(
  layers: WorldLayers,
  seaLevel: number,
  theme: RenderTheme,
  seed: number,
  requestedSize?: number,
): TerrainField {
  const srcN = Math.max(2, layers.size);
  const n = Math.max(2, Math.min(srcN, Math.floor(requestedSize ?? srcN)));
  const cells = n * n;
  let height: Float32Array = layers.height;
  let ocean: Uint8Array = layers.ocean;
  let lake: Uint8Array = layers.lake;
  let biome: Uint8Array = layers.biome;
  let temperature: Float32Array = layers.temperature;
  if (n !== srcN) {
    // Preview quality: sample the simulation grid down to the field resolution.
    const h = new Float32Array(cells);
    const t = new Float32Array(cells);
    const o = new Uint8Array(cells);
    const l = new Uint8Array(cells);
    const b = new Uint8Array(cells);
    for (let y = 0; y < n; y += 1) {
      const v = (y + 0.5) / n;
      const by = Math.min(srcN - 1, Math.floor(v * srcN));
      for (let x = 0; x < n; x += 1) {
        const u = (x + 0.5) / n;
        const i = y * n + x;
        const bx = Math.min(srcN - 1, Math.floor(u * srcN));
        const si = by * srcN + bx;
        h[i] = sampleScalar(layers.height, srcN, u, v);
        t[i] = layers.temperature[si] ?? 0.5;
        o[i] = layers.ocean[si] ?? 0;
        l[i] = layers.lake[si] ?? 0;
        b[i] = layers.biome[si] ?? 0;
      }
    }
    height = h;
    temperature = t;
    ocean = o;
    lake = l;
    biome = b;
  }
  const water = new Uint8Array(cells);
  let maxDepth = 0.001;
  let maxLand = 0.001;
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i] || lake[i]) {
      water[i] = 1;
      if (ocean[i]) {
        const depth = (seaLevel - height[i]) / Math.max(0.02, seaLevel);
        if (depth > maxDepth) maxDepth = depth;
      }
    } else {
      const above = height[i] - seaLevel;
      if (above > maxLand) maxLand = above;
    }
  }

  // Distance to coast: mark cells adjacent to the opposite water/land class.
  const edge = new Uint8Array(cells);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x;
      const w = water[i];
      if (
        (x > 0 && water[i - 1] !== w) ||
        (x < n - 1 && water[i + 1] !== w) ||
        (y > 0 && water[i - n] !== w) ||
        (y < n - 1 && water[i + n] !== w)
      ) {
        edge[i] = 1;
      }
    }
  }
  const boundaryDist = boundaryDistance(edge, n, 10);

  const landLut = buildLandLut(theme);
  const albedo = new Float32Array(cells * 3);
  const tintSeed = (seed ^ 0x2545f491) | 0;
  const washSeed = (seed ^ 0x68e31da4) | 0;
  const exag = theme.hillshade.exaggeration;
  const contour = theme.contour;
  const oceanTheme = theme.ocean;
  const ink = theme.ink;
  const biomeTints = theme.biomeTints;
  const highlight = theme.hillshade.highlight;
  const shadow = theme.hillshade.shadow;
  const highlightMix = theme.hillshade.highlightMix;
  const shadowMix = theme.hillshade.shadowMix;
  const strength = theme.hillshade.strength;

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x;
      const d = boundaryDist[i];
      let r: number;
      let g: number;
      let b: number;
      if (water[i]) {
        if (lake[i]) {
          const depth = 0.25 + 0.35 * smoothstep(0, 8, d);
          const lk = theme.lake;
          r = lk.shallow[0] + (lk.deep[0] - lk.shallow[0]) * depth;
          g = lk.shallow[1] + (lk.deep[1] - lk.shallow[1]) * depth;
          b = lk.shallow[2] + (lk.deep[2] - lk.shallow[2]) * depth;
        } else {
          const rawDepth = (seaLevel - height[i]) / Math.max(0.02, seaLevel);
          const depth = Math.min(1, Math.max(0, rawDepth / maxDepth));
          const shallowT = smoothstep(0, 0.55, depth);
          r = oceanTheme.shallow[0] + (oceanTheme.mid[0] - oceanTheme.shallow[0]) * shallowT;
          g = oceanTheme.shallow[1] + (oceanTheme.mid[1] - oceanTheme.shallow[1]) * shallowT;
          b = oceanTheme.shallow[2] + (oceanTheme.mid[2] - oceanTheme.shallow[2]) * shallowT;
          const deepT = smoothstep(0.5, 1, depth);
          r += (oceanTheme.deep[0] - r) * deepT;
          g += (oceanTheme.deep[1] - g) * deepT;
          b += (oceanTheme.deep[2] - b) * deepT;
        }
        // Pale shelf hugging the coast.
        const shelfT = 1 - smoothstep(0.4, 3.1, d);
        if (shelfT > 0) {
          r += (oceanTheme.shelf[0] - r) * shelfT * 0.45;
          g += (oceanTheme.shelf[1] - g) * shelfT * 0.45;
          b += (oceanTheme.shelf[2] - b) * shelfT * 0.45;
        }
        // Visible paper mottling and age staining over the open sea, so large
        // water areas still read as hand-stained parchment instead of flat wash.
        const wash = valueNoise2(x * 0.035 + 3.1, y * 0.035 + 7.7, washSeed);
        const washFine = valueNoise2(x * 0.11 + 1.7, y * 0.11 + 5.3, washSeed + 17);
        const washMix = (wash - 0.5) * (lake[i] ? 0.2 : 0.5) + (washFine - 0.5) * 0.12;
        r += (oceanTheme.deep[0] - r) * washMix;
        g += (oceanTheme.deep[1] - g) * washMix;
        b += (oceanTheme.deep[2] - b) * washMix;
        // Warm foxing patches: old charts are stained by damp and time.
        const stainPatch = smoothstep(0.62, 0.86, wash * 0.72 + washFine * 0.28);
        if (stainPatch > 0) {
          const k = stainPatch * (lake[i] ? 0.22 : 0.34);
          r += (208 - r) * k;
          g += (194 - g) * k * 0.9;
          b += (158 - b) * k * 0.75;
        }
      } else {
        const t = Math.min(1, Math.max(0, (height[i] - seaLevel) / maxLand));
        let li = (t * (LUT_SIZE - 1)) | 0;
        if (li < 0) li = 0;
        else if (li >= LUT_SIZE) li = LUT_SIZE - 1;
        r = landLut[li * 3];
        g = landLut[li * 3 + 1];
        b = landLut[li * 3 + 2];

        // Local slope / hillshade from the raw heights.
        const xm = x > 0 ? i - 1 : i;
        const xp = x < n - 1 ? i + 1 : i;
        const ym = y > 0 ? i - n : i;
        const yp = y < n - 1 ? i + n : i;
        const dhx = (height[xp] - height[xm]) * 0.5;
        const dhy = (height[yp] - height[ym]) * 0.5;
        const gx = dhx * exag;
        const gy = dhy * exag;
        const gradLen = Math.sqrt(gx * gx + gy * gy);
        const slope = gradLen / exag;
        const curv = (height[xm] + height[xp] + height[ym] + height[yp]) * 0.25 - height[i];
        const relief = (gx + gy) / (1 + gradLen * 0.7) - curv * theme.hillshade.curvature;

        // Rocky texture on steep slopes.
        const rockT = smoothstep(0.02, 0.11, slope) * 0.55;
        if (rockT > 0) {
          r += (theme.land.rock[0] - r) * rockT;
          g += (theme.land.rock[1] - g) * rockT;
          b += (theme.land.rock[2] - b) * rockT;
        }

        // Warm relief wash marks the mountain belts as a distinct ink zone.
        const reliefT = smoothstep(0.32, 0.72, t) * 0.32;
        if (reliefT > 0) {
          r += (theme.land.relief[0] - r) * reliefT;
          g += (theme.land.relief[1] - g) * reliefT;
          b += (theme.land.relief[2] - b) * reliefT;
        }

        // Hand-painted biome wash, broken up with deterministic jitter.
        const biomeId = biome[i] ?? 0;
        const tintColor = biomeTints[biomeId] ?? biomeTints[0];
        const jitter = hashSigned(x, y, tintSeed);
        let tintW = theme.biomeMix * (0.68 + 0.6 * jitter);
        if (biomeId === 12) tintW *= 0.55; // beach
        else if (biomeId === 14) tintW *= 0.4; // snow peak
        else if (biomeId === 13) tintW *= 0.8; // mountain
        if (tintW > 0) {
          r += (tintColor[0] - r) * tintW;
          g += (tintColor[1] - g) * tintW;
          b += (tintColor[2] - b) * tintW;
        }

        // Cold wash toward the poles / high latitude.
        const coldT = (1 - smoothstep(0.12, 0.32, temperature[i] ?? 0.5)) * 0.32;
        if (coldT > 0) {
          r += (theme.land.cold[0] - r) * coldT;
          g += (theme.land.cold[1] - g) * coldT;
          b += (theme.land.cold[2] - b) * coldT;
        }

        // Faded coastal plain where land meets the sea.
        const coastT = (1 - smoothstep(0.4, 2.6, d)) * 0.3;
        if (coastT > 0) {
          r += (theme.paper.light[0] - r) * coastT;
          g += (theme.paper.light[1] - g) * coastT;
          b += (theme.paper.light[2] - b) * coastT;
        }

        // Engraved contour lines baked at simulation resolution.
        const lineW = Math.min(0.42, 0.5 * slope * contour.bands);
        if (lineW > 0.02 && t > 0.08) {
          const band = t * contour.bands;
          const frac = band - Math.floor(band);
          const edgeDist = Math.min(frac, 1 - frac);
          const line = 1 - smoothstep(0, lineW, edgeDist);
          const amount = line * contour.strength;
          if (amount > 0.001) {
            const k = 1 - amount;
            r *= k;
            g *= k;
            b *= k;
            r += ink.main[0] * amount * 0.35;
            g += ink.main[1] * amount * 0.3;
            b += ink.main[2] * amount * 0.22;
          }
        }

        // NW hillshade blended toward warm shadow / pastel highlight, plus a
        // little engraving grain so smooth slopes never look airbrushed.
        const s = Math.max(
          -1,
          Math.min(1, relief * strength + hashSigned(x, y, tintSeed + 77) * 0.08),
        );
        if (s > 0) {
          const k = s * highlightMix;
          r += (highlight[0] - r) * k;
          g += (highlight[1] - g) * k;
          b += (highlight[2] - b) * k;
        } else {
          const k = -s * shadowMix;
          r += (shadow[0] - r) * k;
          g += (shadow[1] - g) * k;
          b += (shadow[2] - b) * k;
        }
      }

      // Parchment colour grade: gently desaturate then warm the plate. Baked
      // here so the per-pixel raster pass stays cheap.
      const luma = r * 0.3 + g * 0.59 + b * 0.11;
      r = (luma + (r - luma) * 0.93) * 1.016 + 2;
      g = (luma + (g - luma) * 0.97) * 0.998 + 1;
      b = (luma + (b - luma) * 1.02) * 0.962;
      albedo[i * 3] = r;
      albedo[i * 3 + 1] = g;
      albedo[i * 3 + 2] = b;
    }
  }

  return { size: n, albedo, boundaryDist, maxDepth, maxLand };
}

/**
 * Low-frequency mottling + age-stain texture. The theme amounts are folded in
 * here so the per-pixel pass only needs one bilinear channel (preview budget).
 */
export function buildPaperTexture(
  theme: RenderTheme,
  seed: number,
  quality: "preview" | "export",
): PaperTexture {
  const res = quality === "export" ? 256 : 128;
  const data = new Float32Array(res * res);
  const seedA = (seed ^ 0x3c6ef372) | 0;
  const seedB = (seed ^ 0x1b873593) | 0;
  const mottleAmt = theme.paper.mottle * 0.0055;
  const stainAmt = theme.paper.stain;
  for (let y = 0; y < res; y += 1) {
    for (let x = 0; x < res; x += 1) {
      const u = x / res;
      const v = y / res;
      const broad = fbm2(u * 3.4 + 1.7, v * 4.1 + 3.3, seedA, 3);
      const mid = valueNoise2(u * 12.3 + 4.7, v * 15.7 + 9.1, seedA + 101);
      const fibre = valueNoise2(u * 9 + 2.3, v * 5.2 + 6.1, seedA + 211);
      let mottle = (broad - 0.5) * 1.15 + (mid - 0.5) * 0.5 + (fibre - 0.5) * 0.16;
      mottle = Math.max(-1, Math.min(1, mottle * 1.55));
      const blob = fbm2(u * 2.6 + 7.7, v * 2.9 + 2.3, seedB, 3);
      const blob2 = valueNoise2(u * 6.4 + 1.3, v * 7.1 + 5.7, seedB + 31);
      const stain = smoothstep(0.54, 0.84, blob * 0.72 + blob2 * 0.28);
      data[y * res + x] = mottle * mottleAmt + (stain - 0.5) * stainAmt * 0.55;
    }
  }
  return { res, data };
}

export interface RasterStats {
  fieldMs: number;
  rasterMs: number;
}

const paperCache = new Map<string, PaperTexture>();

/** Cached paper texture: style-only re-renders reuse it. */
export function getPaperTexture(theme: RenderTheme, seed: number, quality: "preview" | "export"): PaperTexture {
  const key = `${seed}|${quality}|${theme.preset}|${theme.paper.mottle.toFixed(2)}|${theme.paper.stain.toFixed(3)}|${theme.paper.grain.toFixed(2)}`;
  const cached = paperCache.get(key);
  if (cached) return cached;
  const texture = buildPaperTexture(theme, seed, quality);
  if (paperCache.size > 4) paperCache.clear();
  paperCache.set(key, texture);
  return texture;
}

/** Draw the parchment raster into the target context (one putImageData). */
export function rasterizeParchment(
  ctx: {
    createImageData(width: number, height: number): ImageDataLike;
    putImageData(image: ImageDataLike, dx: number, dy: number): void;
  },
  width: number,
  height: number,
  field: TerrainField,
  paper: PaperTexture,
  theme: RenderTheme,
  seed: number,
  quality: "preview" | "export",
  fieldMs: number,
): RasterStats {
  const t0 = now();
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const n = field.size;
  const albedo = field.albedo;

  const colIdx = new Int32Array(width);
  const colFrac = new Float32Array(width);
  const paperIdx = new Int32Array(width);
  const paperFrac = new Float32Array(width);
  const vx = new Float32Array(width);
  const pres = paper.res;
  for (let x = 0; x < width; x += 1) {
    const sx = ((x + 0.5) * n) / width - 0.5;
    let ix = Math.floor(sx);
    let fx = sx - ix;
    if (ix < 0) {
      ix = 0;
      fx = 0;
    } else if (ix >= n - 1) {
      ix = n - 2;
      fx = 1;
    }
    colIdx[x] = ix;
    colFrac[x] = fx;
    const tx = ((x + 0.5) * pres) / width - 0.5;
    let txi = Math.floor(tx);
    let tfx = tx - txi;
    if (txi < 0) {
      txi = 0;
      tfx = 0;
    } else if (txi >= pres - 1) {
      txi = pres - 2;
      tfx = 1;
    }
    paperIdx[x] = txi;
    paperFrac[x] = tfx;
    const dx = ((x + 0.5) / width - 0.5) * 2;
    vx[x] = dx * dx * 0.82;
  }
  const rowIdx = new Int32Array(height);
  const rowFrac = new Float32Array(height);
  const paperRowIdx = new Int32Array(height);
  const paperRowFrac = new Float32Array(height);
  const vy = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    const sy = ((y + 0.5) * n) / height - 0.5;
    let iy = Math.floor(sy);
    let fy = sy - iy;
    if (iy < 0) {
      iy = 0;
      fy = 0;
    } else if (iy >= n - 1) {
      iy = n - 2;
      fy = 1;
    }
    rowIdx[y] = iy;
    rowFrac[y] = fy;
    const ty = ((y + 0.5) * pres) / height - 0.5;
    let tyi = Math.floor(ty);
    let tfy = ty - tyi;
    if (tyi < 0) {
      tyi = 0;
      tfy = 0;
    } else if (tyi >= pres - 1) {
      tyi = pres - 2;
      tfy = 1;
    }
    paperRowIdx[y] = tyi;
    paperRowFrac[y] = tfy;
    const dy = ((y + 0.5) / height - 0.5) * 2;
    vy[y] = dy * dy * 0.82;
  }

  const vignette = theme.paper.vignette;
  const grainAmt = theme.paper.grain * (quality === "export" ? 0.0035 : 0.005);
  const grainSeed = (seed ^ 0x2545f491) | 0;
  const tex = paper.data;

  for (let y = 0; y < height; y += 1) {
    const iy = rowIdx[y];
    const fy = rowFrac[y];
    const rowA = iy * n;
    const rowB = rowA + n;
    const pY = paperRowIdx[y];
    const pFy = paperRowFrac[y];
    const vY = vy[y];
    const pRowA = pY * pres;
    let o = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const ix = colIdx[x];
      const fx = colFrac[x];
      const i00 = rowA + ix;
      const i10 = i00 + 1;
      const i01 = rowB + ix;
      const i11 = i01 + 1;

      // Bilinear albedo.
      const tr = albedo[i00 * 3] + (albedo[i10 * 3] - albedo[i00 * 3]) * fx;
      const tg = albedo[i00 * 3 + 1] + (albedo[i10 * 3 + 1] - albedo[i00 * 3 + 1]) * fx;
      const tb = albedo[i00 * 3 + 2] + (albedo[i10 * 3 + 2] - albedo[i00 * 3 + 2]) * fx;
      const br = albedo[i01 * 3] + (albedo[i11 * 3] - albedo[i01 * 3]) * fx;
      const bg = albedo[i01 * 3 + 1] + (albedo[i11 * 3 + 1] - albedo[i01 * 3 + 1]) * fx;
      const bb = albedo[i01 * 3 + 2] + (albedo[i11 * 3 + 2] - albedo[i01 * 3 + 2]) * fx;
      let r = tr + (br - tr) * fy;
      let g = tg + (bg - tg) * fy;
      let b = tb + (bb - tb) * fy;

      // Bilinear paper texture (mottle, stain).
      const pIx = paperIdx[x];
      const pFx = paperFrac[x];
      const p00 = pRowA + pIx;
      const p10 = p00 + 1;
      const p01 = p00 + pres;
      const p11 = p01 + 1;
      const pw00 = (1 - pFx) * (1 - pFy);
      const pw10 = pFx * (1 - pFy);
      const pw01 = (1 - pFx) * pFy;
      const pw11 = pFx * pFy;
      let mul = 1 + (tex[p00] * pw00 + tex[p10] * pw10 + tex[p01] * pw01 + tex[p11] * pw11);
      // Per-pixel grain (integer hash, identical on every platform).
      let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ grainSeed) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      mul += ((h >>> 0) * 2.3283064365e-10 - 0.5) * grainAmt;
      // Vignette + outer margin burn.
      const d2 = vx[x] + vY;
      mul *= 1 - vignette * (d2 * 0.55 + d2 * d2 * 0.45);
      r *= mul;
      g *= mul;
      b *= mul;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
      o += 4;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { fieldMs, rasterMs: now() - t0 };
}

/** Small helper shared by the renderer: format a color for diagnostics. */
export function debugColor(color: RGB): string {
  return cssRgb(color);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
