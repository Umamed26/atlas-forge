/**
 * Terrain stage.
 *
 * Pipeline (all deterministic from seed + params):
 *  1. low-res fBm fields: two domain-warp fields, a continent field, a ridged
 *     multifractal mountain field, a mountain-placement mask and fine detail
 *  2. per-cell combination: domain-warped continent fBm + radial falloff
 *     (continentality) + ridged mountains + fine detail
 *  3. thermal relaxation + hydraulic droplet erosion (erosionIterations)
 *  4. brush overrides: elevation stamps, then forced-river carving (both before
 *     depression filling, per the pipeline contract)
 *
 * Everything is written in place into the returned Float32Array; no cached
 * array is ever mutated (the pipeline passes a freshly built field here).
 */
import { applyElevationStamps, carveRiverForce } from "./overrides";
import { buildField, clamp, clamp01, fbm, makeRng, ridgedMultifractal, sampleField, smoothstep01 } from "./rng";
import type { WorldOverrides, WorldParams } from "./types";

export interface TerrainResult {
  /** Post-erosion height 0..1, including brush overrides. */
  height: Float32Array;
  /** Forced-river centreline mask (1 = user-forced channel); hydrology forces these cells to river. */
  channel: Uint8Array;
}

/** Fixed-size helper field resolution (independently of the simulation grid). */
function fieldRes(size: number, max: number): number {
  return Math.max(8, Math.min(size, max));
}

export function generateTerrain(
  size: number,
  seed: number,
  params: WorldParams,
  overrides: WorldOverrides | undefined,
): TerrainResult {
  const n = size * size;
  const height = new Float32Array(n);
  height.fill(NaN);

  const continentScale = clamp(params.continentScale, 0.25, 4);
  const continentality = clamp01(params.continentality);
  const warpStrength = clamp01(params.warpStrength);
  const ridgeStrength = clamp01(params.ridgeStrength);
  const ridgeScale = clamp(params.ridgeScale, 0.4, 5);
  const erosionIterations = clamp(Math.round(params.erosionIterations), 0, 200);

  // ── Precomputed noise fields (low frequency, bilinear upsampled) ────────
  const warpRes = fieldRes(size, 160);
  const warpAmp = warpStrength * 0.13;
  const warpX = buildField(warpRes, (u, v) => fbm(u * 2.3 + 3.7, v * 2.3 + 8.1, seed + 101, 3) - 0.5);
  const warpY = buildField(warpRes, (u, v) => fbm(u * 2.3 - 5.3, v * 2.3 + 1.9, seed + 211, 3) - 0.5);

  const contRes = fieldRes(size, 384);
  const contFreq = 1.55 * continentScale;
  const continent = buildField(contRes, (u, v) => fbm(u * contFreq + 3.1, v * contFreq + 7.7, seed, 5) - 0.5);

  const ridgeRes = fieldRes(size, 384);
  const ridgeFreq = 3.4 * ridgeScale;
  // Mountain placement mask is baked into the ridge field: one less full-res
  // bilinear sample per cell, identical look (both sampled at their own grid).
  const ridges = buildField(ridgeRes, (u, v) => {
    const mask = smoothstep01((fbm(u * 1.45 + 11.3, v * 1.45 + 2.7, seed + 401, 3) - 0.28) * 1.9);
    return ridgedMultifractal(u * ridgeFreq, v * ridgeFreq, seed + 307, 4, 2, 0.5) * (0.25 + 0.75 * mask);
  });

  const detailRes = fieldRes(size, 256);
  const detail = buildField(detailRes, (u, v) => fbm(u * 22 + 5.9, v * 22 + 13.1, seed + 509, 2) - 0.5);

  // ── Per-cell combination ────────────────────────────────────────────────
  const invSize = 1 / size;
  const edgeWidth = Math.max(2, size * 0.035);
  const ridgeAmp = ridgeStrength * 0.62;

  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) * invSize;
    const row = y * size;
    const dy = v * 2 - 1;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * invSize;
      const dx = u * 2 - 1;

      // Domain warp.
      const wxo = sampleField(warpX, warpRes, u, v) * warpAmp * 2;
      const wyo = sampleField(warpY, warpRes, u, v) * warpAmp * 2;
      const wu = u + wxo;
      const wv = v + wyo;

      const cont = sampleField(continent, contRes, wu, wv);
      const ridge = sampleField(ridges, ridgeRes, wu, wv);
      const fine = sampleField(detail, detailRes, u, v);

      // Continent base: fBm zero-mean field stretched into 0..1.
      let h = 0.5 + cont * 1.35;

      // Radial falloff toward map edges (continentality).
      const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const fall = smoothstep01((dist - 0.3) / 0.62) * continentality;
      h -= fall * 0.98;

      // Ridged mountains, clustered by a low-frequency placement mask.
      const mountain = ridge * ridgeAmp * (0.45 + 0.55 * clamp01(0.5 + cont * 1.2));
      h += mountain;

      // Fine detail, weaker at high altitudes so peaks stay readable.
      h += fine * 0.11;

      height[row + x] = h;
    }
  }

  // ── Distribution calibration + ocean border ────────────────────────────
  // Affine normalisation gives every seed a comparable height distribution
  // (so the seaLevel slider means the same thing world to world) while
  // preserving the seed's relief structure.
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += height[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i += 1) {
    const d = height[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / n) || 1;
  const targetMean = 0.36;
  const targetStd = 0.18;
  const scale = targetStd / std;
  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    for (let x = 0; x < size; x += 1) {
      const i = row + x;
      let h = (height[i] - mean) * scale + targetMean;
      const edgeDist = Math.min(x, size - 1 - x, y, size - 1 - y);
      let edge = edgeDist / edgeWidth;
      if (edge > 1) edge = 1;
      h *= smoothstep01(edge);
      height[i] = clamp01(h);
    }
  }

  // ── Erosion ─────────────────────────────────────────────────────────────
  if (erosionIterations > 0) {
    const thermalPasses = Math.min(2, Math.max(1, Math.round(erosionIterations / 60)));
    thermalErode(height, size, thermalPasses, 0.022, 0.5);
    const droplets = Math.min(40000, Math.round(erosionIterations * size * 0.04));
    hydraulicErode(height, size, droplets, seed, erosionIterations);
  }

  // ── Brush overrides (before hydrology fills depressions) ───────────────
  applyElevationStamps(height, size, overrides?.elevation);
  const channel = carveRiverForce(height, size, overrides?.riverForce);

  for (let i = 0; i < n; i += 1) {
    const h = height[i];
    height[i] = Number.isFinite(h) ? (h < 0 ? 0 : h > 1 ? 1 : h) : 0;
  }

  return { height, channel };
}

/**
 * Thermal (talus) relaxation: material above the angle of repose slides to the
 * steepest downhill neighbour. Moves are accumulated before applying so the
 * pass is directionally unbiased.
 */
export function thermalErode(
  height: Float32Array,
  size: number,
  passes: number,
  talus: number,
  rate: number,
): void {
  const n = size * size;
  const delta = new Float32Array(n);
  for (let pass = 0; pass < passes; pass += 1) {
    delta.fill(0);
    for (let y = 1; y < size - 1; y += 1) {
      const row = y * size;
      for (let x = 1; x < size - 1; x += 1) {
        const i = row + x;
        const h = height[i];
        let bestDelta = 0;
        let bestIndex = -1;
        // 4-neighbour stability is plenty after the frequency-limited noise.
        const left = height[i - 1];
        const right = height[i + 1];
        const up = height[i - size];
        const down = height[i + size];
        let diff = h - left;
        if (diff > bestDelta) {
          bestDelta = diff;
          bestIndex = i - 1;
        }
        diff = h - right;
        if (diff > bestDelta) {
          bestDelta = diff;
          bestIndex = i + 1;
        }
        diff = h - up;
        if (diff > bestDelta) {
          bestDelta = diff;
          bestIndex = i - size;
        }
        diff = h - down;
        if (diff > bestDelta) {
          bestDelta = diff;
          bestIndex = i + size;
        }
        if (bestIndex < 0 || bestDelta <= talus) continue;
        const move = Math.min((bestDelta - talus) * rate, bestDelta * 0.5);
        delta[i] -= move;
        delta[bestIndex] += move;
      }
    }
    for (let i = 0; i < n; i += 1) {
      height[i] = clamp01(height[i] + delta[i]);
    }
  }
}

/**
 * Hydraulic droplet erosion (stream-power-like sediment transport).
 * `droplets` is derived from erosionIterations; the number of simulation steps
 * per droplet is fixed, so cost is bounded and deterministic.
 */
export function hydraulicErode(
  height: Float32Array,
  size: number,
  droplets: number,
  seed: number,
  erosionIterations: number,
): void {
  if (droplets <= 0) return;
  const n = size * size;
  const rng = makeRng((seed ^ 0x9e3779b9 ^ Math.imul(erosionIterations + 1, 0x85ebca6b)) >>> 0);
  const inertia = 0.12;
  const capacityFactor = 4;
  const minSlope = 0.0015;
  const depositRate = 0.32;
  const erodeRate = 0.28;
  const evaporate = 0.02;
  const gravity = 6;
  const maxSteps = 44;

  const sample = (px: number, py: number): number => {
    const x0 = px | 0;
    const y0 = py | 0;
    const x1 = x0 < size - 1 ? x0 + 1 : x0;
    const y1 = y0 < size - 1 ? y0 + 1 : y0;
    const tx = px - x0;
    const ty = py - y0;
    const a = height[y0 * size + x0];
    const b = height[y0 * size + x1];
    const c = height[y1 * size + x0];
    const d = height[y1 * size + x1];
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    return top + (bottom - top) * ty;
  };

  for (let d = 0; d < droplets; d += 1) {
    let px = rng() * (size - 1);
    let py = rng() * (size - 1);
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      const gx = clamp(Math.floor(px), 1, size - 2);
      const gy = clamp(Math.floor(py), 1, size - 2);
      const center = gx + gy * size;
      const oldHeight = sample(px, py);
      const gradX = (height[center + 1] - height[center - 1]) * 0.5;
      const gradY = (height[center + size] - height[center - size]) * 0.5;
      dirX = dirX * inertia - gradX * (1 - inertia);
      dirY = dirY * inertia - gradY * (1 - inertia);
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len > 1e-9) {
        dirX /= len;
        dirY /= len;
      } else {
        const angle = rng() * Math.PI * 2;
        dirX = Math.cos(angle);
        dirY = Math.sin(angle);
      }
      const nx = clamp(px + dirX, 1, size - 2.01);
      const ny = clamp(py + dirY, 1, size - 2.01);
      const newHeight = sample(nx, ny);
      const diff = newHeight - oldHeight;
      const capacity = Math.max(-diff, minSlope) * speed * water * capacityFactor;
      if (sediment > capacity) {
        const deposit = (sediment - capacity) * depositRate;
        sediment -= deposit;
        brush(height, size, nx, ny, deposit);
      } else {
        const erode = Math.min((capacity - sediment) * erodeRate, Math.max(0, oldHeight) * 0.5 + 0.002);
        if (erode > 0) {
          brush(height, size, nx, ny, -erode);
          sediment += erode;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + -diff * gravity));
      water *= 1 - evaporate;
      px = nx;
      py = ny;
      if (water < 0.02) break;
    }
  }
  // Numerical safety: keep the field in range after droplets.
  for (let i = 0; i < n; i += 1) height[i] = clamp01(height[i]);
}

/** Bilinear deposit/remove of material around a fractional cell position. */
function brush(
  height: Float32Array,
  size: number,
  px: number,
  py: number,
  amount: number,
): void {
  const x0 = px | 0;
  const y0 = py | 0;
  const tx = px - x0;
  const ty = py - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const i00 = y0 * size + x0;
  height[i00] = clamp01(height[i00] + amount * w00);
  height[i00 + 1] = clamp01(height[i00 + 1] + amount * w10);
  height[i00 + size] = clamp01(height[i00 + size] + amount * w01);
  height[i00 + size + 1] = clamp01(height[i00 + size + 1] + amount * w11);
}

