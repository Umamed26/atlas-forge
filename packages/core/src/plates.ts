/**
 * Voronoi plate-tectonics model (v0.5 terrain).
 *
 * Deterministic from (seed, size, params):
 *  1. 22-30 blue-noise-ish plate sites (best-candidate sampling + a couple of
 *     Lloyd relaxation steps) so the map does not read as a jittered grid
 *  2. each plate gets a continental/oceanic type, a motion vector and a base
 *     elevation bias sampled from a smooth low-frequency field
 *  3. plate ownership on a reduced grid, refined with exact nearest-site lookup
 *     at boundaries; all *height* contributions are smoothly blurred across
 *     boundaries (a hard per-plate step would leak the Voronoi edges into the
 *     coastline as straight polygon segments)
 *  4. per-boundary relative-motion classification into convergent (mountain
 *     belts), divergent (rifts / mid-ocean ridges) and transform (shear)
 *
 * The model is data-only; height synthesis lives in terrain.ts.
 */
import { buildField, clamp, clamp01, fbm, hash2, makeRng, sampleField } from "./rng";
import type { WorldParams } from "./types";

export interface PlateModel {
  /** Number of plates (12..32, default 22..30). */
  count: number;
  /** Per-cell plate index (0..count-1). */
  id: Uint8Array;
  /** 0..1 closeness to a plate boundary (1 = on the boundary). */
  boundary: Float32Array;
  /** 0..1 convergent mountain-belt strength. */
  convergence: Float32Array;
  /**
   * 0..1 orogenic belt mask: gaussian falloff around convergent boundaries,
   * computed from a BFS distance transform so belts are smooth meandering bands
   * (a Voronoi closeness field alone produces triangular wedges).
   */
  beltMask: Float32Array;
  /** 0..1 divergent rift / mid-ocean-ridge strength. */
  divergence: Float32Array;
  /** Smoothed plate base elevation contribution per cell (no Voronoi steps). */
  baseField: Float32Array;
  /** Per-plate average base elevation (debug / rendering hints). */
  base: Float32Array;
  /** 1 = continental plate. */
  continental: Uint8Array;
}

interface PlateSite {
  u: number;
  v: number;
  vx: number;
  vy: number;
  speed: number;
  continental: boolean;
  baseBias: number;
}

function resolvePlateCount(params: WorldParams, seed: number): number {
  const requested = params.tectonicPlates;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return clamp(Math.round(requested), 12, 32);
  }
  // Default: 26 ± 4 (blue-noise sites stay readable at this density).
  return 22 + (hash2(seed, 0x9e37, 0x5eed) % 9);
}

/** Deterministic best-candidate sampling for blue-noise-ish site placement. */
function blueNoiseSites(count: number, seed: number): { u: number; v: number }[] {
  const rng = makeRng((seed ^ 0x51ed270b) >>> 0);
  const chosen: { u: number; v: number }[] = [];
  // First site near the middle (reduces edge bias).
  chosen.push({ u: 0.5 + (rng() - 0.5) * 0.1, v: 0.5 + (rng() - 0.5) * 0.1 });
  const candidatesPerPick = 18;
  while (chosen.length < count) {
    let bestU = 0;
    let bestV = 0;
    let bestDistance = -1;
    for (let attempt = 0; attempt < candidatesPerPick; attempt += 1) {
      const u = rng();
      const v = rng();
      let nearest = Infinity;
      for (const site of chosen) {
        const du = site.u - u;
        const dv = site.v - v;
        const distance = du * du + dv * dv;
        if (distance < nearest) nearest = distance;
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestU = u;
        bestV = v;
      }
    }
    chosen.push({ u: bestU, v: bestV });
  }
  // Two Lloyd relaxation steps on a coarse sampling grid -> more even spacing.
  const relaxRes = 72;
  for (let pass = 0; pass < 2; pass += 1) {
    const sumU = new Float64Array(count);
    const sumV = new Float64Array(count);
    const weight = new Float64Array(count);
    for (let y = 0; y < relaxRes; y += 1) {
      const v = (y + 0.5) / relaxRes;
      for (let x = 0; x < relaxRes; x += 1) {
        const u = (x + 0.5) / relaxRes;
        let best = 0;
        let bestDist = Infinity;
        for (let p = 0; p < count; p += 1) {
          const du = chosen[p].u - u;
          const dv = chosen[p].v - v;
          const distance = du * du + dv * dv;
          if (distance < bestDist) {
            bestDist = distance;
            best = p;
          }
        }
        sumU[best] += u;
        sumV[best] += v;
        weight[best] += 1;
      }
    }
    for (let p = 0; p < count; p += 1) {
      if (weight[p] < 3) continue;
      chosen[p].u = clamp01(sumU[p] / weight[p]);
      chosen[p].v = clamp01(sumV[p] / weight[p]);
    }
  }
  return chosen;
}

export function generatePlateModel(size: number, seed: number, params: WorldParams): PlateModel {
  const count = resolvePlateCount(params, seed);
  const continentScale = clamp(params.continentScale, 0.25, 4);
  const continentalFraction = clamp(0.38 + (continentScale - 1) * 0.12, 0.28, 0.62);
  const rng = makeRng((seed ^ 0x7f4a7c15) >>> 0);
  const positions = blueNoiseSites(count, seed);

  // Type assignment + per-plate bias from a smooth low-frequency field.
  const biasField = buildField(96, (u, v) => fbm(u * 1.7 + 3.3, v * 1.7 + 8.9, seed + 901, 3) - 0.5);
  const order = Array.from({ length: count }, (_, index) => index);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const continentalCount = clamp(Math.round(count * continentalFraction), 3, count - 3);
  const continental = new Uint8Array(count);
  const sites: PlateSite[] = positions.map((position) => {
    const angle = rng() * Math.PI * 2;
    const speed = 0.35 + rng() * 0.9;
    return {
      u: position.u,
      v: position.v,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      speed,
      continental: false,
      baseBias: sampleField(biasField, 96, position.u, position.v) * 0.14,
    };
  });
  for (let rank = 0; rank < count; rank += 1) {
    const site = sites[order[rank]];
    site.continental = rank < continentalCount;
    continental[order[rank]] = site.continental ? 1 : 0;
    // Continental plates are lifted, oceanic plates sit low; the smooth
    // low-frequency bias avoids per-plate hard steps.
    // v0.5.1: gentler per-plate bias. A larger step (0.11/-0.13) survived the
    // blur as a cliff along the Voronoi edge (visible as a bright crease in the
    // slope map) and created giant interior basins that flooded as lakes.
    site.baseBias += site.continental ? 0.055 : -0.075;
  }

  // ── Reduced-resolution plate grid ─────────────────────────────────────
  const plateRes = Math.max(96, Math.min(size, 384));
  const lowId = new Uint8Array(plateRes * plateRes);
  const lowBoundary = new Float32Array(plateRes * plateRes);
  const lowConvergence = new Float32Array(plateRes * plateRes);
  const lowDivergence = new Float32Array(plateRes * plateRes);
  const lowBase = new Float32Array(plateRes * plateRes);
  const spacing = 1 / Math.sqrt(count);
  const inv = 1 / plateRes;
  const baseNoise = buildField(plateRes, (u, v) => fbm(u * 2.4 + 12.7, v * 2.4 + 5.1, seed + 733, 4) - 0.5);

  for (let y = 0; y < plateRes; y += 1) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < plateRes; x += 1) {
      const u = (x + 0.5) * inv;
      let first = -1;
      let second = -1;
      let d1 = Infinity;
      let d2 = Infinity;
      for (let p = 0; p < count; p += 1) {
        const du = sites[p].u - u;
        const dv = sites[p].v - v;
        const distance = du * du + dv * dv;
        if (distance < d1) {
          d2 = d1;
          second = first;
          d1 = distance;
          first = p;
        } else if (distance < d2) {
          d2 = distance;
          second = p;
        }
      }
      const index = y * plateRes + x;
      lowId[index] = first;
      // Smooth base: plate bias blended with low-frequency field noise.
      lowBase[index] = sites[first].baseBias + sampleField(baseNoise, plateRes, u, v) * 0.16;
      if (second < 0) continue;
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      const closeness = clamp01(1 - edge / (spacing * 0.9));
      lowBoundary[index] = closeness * closeness;

      const nx = sites[second].u - sites[first].u;
      const ny = sites[second].v - sites[first].v;
      const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
      const relative =
        (sites[first].vx - sites[second].vx) * (nx / nlen) +
        (sites[first].vy - sites[second].vy) * (ny / nlen);
      const speed = 0.35 + 0.5 * (sites[first].speed + sites[second].speed);
      const convergent = clamp01(relative / speed);
      const divergent = clamp01(-relative / speed);
      const continentalPair =
        continental[first] + continental[second];
      lowConvergence[index] = convergent * (0.55 + 0.45 * (continentalPair / 2));
      lowDivergence[index] = divergent;
    }
  }

  // ── Orogenic belt mask (distance transform around convergent edges) ────
  // Source cells: near-boundary cells whose relative motion is convergent.
  // Gaussian falloff with a noise-warped width gives meandering ranges rather
  // than the triangular wedge produced by a raw Voronoi closeness field.
  const convSource = new Uint8Array(plateRes * plateRes);
  let convCount = 0;
  for (let i = 0; i < plateRes * plateRes; i += 1) {
    if (lowBoundary[i] > 0.35 && lowConvergence[i] > 0.22) {
      convSource[i] = 1;
      convCount += 1;
    }
  }
  const beltMaskLow = new Float32Array(plateRes * plateRes);
  if (convCount > 0) {
    const distance = new Float32Array(plateRes * plateRes).fill(Infinity);
    const queue = new Int32Array(plateRes * plateRes);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < plateRes * plateRes; i += 1) {
      if (convSource[i]) {
        distance[i] = 0;
        queue[tail++] = i;
      }
    }
    const stride = plateRes;
    while (head < tail) {
      const cell = queue[head++];
      const cx = cell % stride;
      const cy = (cell / stride) | 0;
      const d = distance[cell] + 1;
      for (let k = 0; k < 4; k += 1) {
        const nx = cx + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = cy + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= stride || ny >= stride) continue;
        const n = ny * stride + nx;
        if (distance[n] > d) {
          distance[n] = d;
          queue[tail++] = n;
        }
      }
    }
    const baseWidth = Math.max(3, Math.round((spacing * plateRes) * 0.42));
    const widthNoise = buildField(plateRes, (u, v) => fbm(u * 3.1 + 4.4, v * 3.1 + 9.2, seed + 1777, 3) - 0.5);
    for (let y = 0; y < plateRes; y += 1) {
      for (let x = 0; x < plateRes; x += 1) {
        const i = y * plateRes + x;
        const u = (x + 0.5) / plateRes;
        const v = (y + 0.5) / plateRes;
        const width = baseWidth * (0.65 + 0.9 * clamp01(0.5 + sampleField(widthNoise, plateRes, u, v) * 1.6));
        const t = distance[i] / width;
        beltMaskLow[i] = Math.exp(-t * t);
      }
    }
  }

  // Blur the base field across plate boundaries. 14 binomial passes on the
  // reduced grid smooth the step over several percent of the map; with only 5
  // passes the transition stayed under one screen pixel of slope and read as a
  // crack running through the continent.
  let source = lowBase;
  let target = new Float32Array(source.length);
  for (let pass = 0; pass < 14; pass += 1) {
    for (let y = 0; y < plateRes; y += 1) {
      const row = y * plateRes;
      const rowUp = (y > 0 ? y - 1 : y) * plateRes;
      const rowDown = (y < plateRes - 1 ? y + 1 : y) * plateRes;
      for (let x = 0; x < plateRes; x += 1) {
        const left = x > 0 ? x - 1 : x;
        const right = x < plateRes - 1 ? x + 1 : x;
        const center =
          source[row + x] * 4 +
          source[row + left] +
          source[row + right] +
          source[rowUp + x] +
          source[rowDown + x];
        target[row + x] = center / 8;
      }
    }
    const swap = source;
    source = target;
    target = swap;
  }
  const lowBaseSmooth = source;

  // ── Full-resolution fields ────────────────────────────────────────────
  const cells = size * size;
  const id = new Uint8Array(cells);
  const boundary = new Float32Array(cells);
  const convergence = new Float32Array(cells);
  const divergence = new Float32Array(cells);
  const baseField = new Float32Array(cells);
  const base = new Float32Array(count);
  for (let p = 0; p < count; p += 1) base[p] = sites[p].baseBias;

  const beltMask = new Float32Array(cells);
  const step = plateRes / size;
  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    for (let x = 0; x < size; x += 1) {
      const index = row + x;
      const fx = (x + 0.5) * step - 0.5;
      const fy = (y + 0.5) * step - 0.5;
      const x0 = clamp(Math.floor(fx), 0, plateRes - 1);
      const y0 = clamp(Math.floor(fy), 0, plateRes - 1);
      const x1 = Math.min(plateRes - 1, x0 + 1);
      const y1 = Math.min(plateRes - 1, y0 + 1);
      const tx = clamp01(fx - x0);
      const ty = clamp01(fy - y0);
      const b00 = lowBoundary[y0 * plateRes + x0];
      const b10 = lowBoundary[y0 * plateRes + x1];
      const b01 = lowBoundary[y1 * plateRes + x0];
      const b11 = lowBoundary[y1 * plateRes + x1];
      const top = b00 + (b10 - b00) * tx;
      const bottom = b01 + (b11 - b01) * tx;
      boundary[index] = top + (bottom - top) * ty;
      const c00 = lowConvergence[y0 * plateRes + x0];
      const c10 = lowConvergence[y0 * plateRes + x1];
      const c01 = lowConvergence[y1 * plateRes + x0];
      const c11 = lowConvergence[y1 * plateRes + x1];
      const ctop = c00 + (c10 - c00) * tx;
      const cbottom = c01 + (c11 - c01) * tx;
      convergence[index] = ctop + (cbottom - ctop) * ty;
      const d00 = lowDivergence[y0 * plateRes + x0];
      const d10 = lowDivergence[y0 * plateRes + x1];
      const d01 = lowDivergence[y1 * plateRes + x0];
      const d11 = lowDivergence[y1 * plateRes + x1];
      const dtop = d00 + (d10 - d00) * tx;
      const dbottom = d01 + (d11 - d01) * tx;
      divergence[index] = dtop + (dbottom - dtop) * ty;
      const s00 = lowBaseSmooth[y0 * plateRes + x0];
      const s10 = lowBaseSmooth[y0 * plateRes + x1];
      const s01 = lowBaseSmooth[y1 * plateRes + x0];
      const s11 = lowBaseSmooth[y1 * plateRes + x1];
      const stop = s00 + (s10 - s00) * tx;
      const sbottom = s01 + (s11 - s01) * tx;
      baseField[index] = stop + (sbottom - stop) * ty;

      const m00 = beltMaskLow[y0 * plateRes + x0];
      const m10 = beltMaskLow[y0 * plateRes + x1];
      const m01 = beltMaskLow[y1 * plateRes + x0];
      const m11 = beltMaskLow[y1 * plateRes + x1];
      const mtop = m00 + (m10 - m00) * tx;
      const mbottom = m01 + (m11 - m01) * tx;
      beltMask[index] = mtop + (mbottom - mtop) * ty;

      const id00 = lowId[y0 * plateRes + x0];
      const id10 = lowId[y0 * plateRes + x1];
      const id01 = lowId[y1 * plateRes + x0];
      const id11 = lowId[y1 * plateRes + x1];
      if (id00 === id10 && id00 === id01 && id00 === id11) {
        id[index] = id00;
      } else {
        const u = (x + 0.5) / size;
        const v = (y + 0.5) / size;
        let best = 0;
        let bestDist = Infinity;
        for (let p = 0; p < count; p += 1) {
          const du = sites[p].u - u;
          const dv = sites[p].v - v;
          const distance = du * du + dv * dv;
          if (distance < bestDist) {
            bestDist = distance;
            best = p;
          }
        }
        id[index] = best;
      }
    }
  }

  return { count, id, boundary, convergence, divergence, beltMask, baseField, base, continental };
}
