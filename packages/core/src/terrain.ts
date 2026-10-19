/**
 * Terrain stage.
 *
 * v0.5 default ("plates"):
 *  1. Voronoi plate model (types / motion / base offsets + convergent,
 *     divergent and transform boundary fields) from `plates.ts`
 *  2. per-cell synthesis: plate base + boundary mountain belts (ridged
 *     multifractal modulated) + rifts + weak intra-plate noise + detail,
 *     then domain warp + radial continentality falloff
 *  3. distribution calibration + ocean border (same as legacy fbm path)
 *  4. thermal + droplet erosion, then a stream-power pass driven by a coarse
 *     depression fill + D8 flow accumulation (real valleys / alluvial floors)
 *  5. brush overrides (elevation stamps, forced-river carving)
 *
 * The legacy "fbm" model (pre-v0.5 documents) keeps the exact same code path
 * and is bit-for-bit identical to the v0.4 implementation.
 */
import { computeDrainage } from "./hydrology";
import { applyElevationStamps, carveRiverForce } from "./overrides";
import { generatePlateModel, type PlateModel } from "./plates";
import {
  buildField,
  clamp,
  clamp01,
  fbm,
  makeRng,
  ridgedMultifractal,
  sampleField,
  smoothstep01,
} from "./rng";
import type { TerrainModel, WorldOverrides, WorldParams } from "./types";

export interface TerrainResult {
  /** Post-erosion height 0..1, including brush overrides. */
  height: Float32Array;
  /** Forced-river centreline mask (1 = user-forced channel); hydrology forces these cells to river. */
  channel: Uint8Array;
  /** Tectonic plate ownership (plates model only, debug / optional rendering). */
  plates?: { id: Uint8Array; count: number };
}

export interface TerrainOptions {
  /** Terrain model to build; defaults to params.terrainModel / "fbm". */
  model?: TerrainModel;
  /**
   * v0.5 pipeline semantics (interior-basin lifting, lake policy). Legacy
   * documents pass false to keep the v0.4 bit-identical pipeline.
   */
  modern?: boolean;
}

/** Fixed-size helper field resolution (independently of the simulation grid). */
function fieldRes(size: number, max: number): number {
  return Math.max(8, Math.min(size, max));
}

function noiseField(
  size: number,
  maxRes: number,
  evaluate: (u: number, v: number) => number,
): Float32Array {
  const res = fieldRes(size, maxRes);
  return buildField(res, evaluate);
}

/** Sample a Uint8 plate-id grid at fractional (u, v); nearest cell. */
function plateIdAt(ids: Uint8Array, size: number, u: number, v: number): number {
  const x = clamp(Math.round(u * (size - 1)), 0, size - 1);
  const y = clamp(Math.round(v * (size - 1)), 0, size - 1);
  return ids[y * size + x];
}

export function generateTerrain(
  size: number,
  seed: number,
  params: WorldParams,
  overrides: WorldOverrides | undefined,
  options: TerrainOptions = {},
): TerrainResult {
  const n = size * size;
  const height = new Float32Array(n);
  height.fill(NaN);

  const model: TerrainModel =
    options.model ?? (params.terrainModel === "fbm" ? "fbm" : "plates");
  const modernTerrain = options.modern !== false;
  const plateModel = model === "plates" ? generatePlateModel(size, seed, params) : undefined;
  if (model === "plates" && plateModel) {
    buildPlateHeight(height, size, seed, params, plateModel);
  } else {
    buildFbmHeight(height, size, seed, params);
  }

  normalizeHeight(height, size);
  const erosionIterations = clamp(Math.round(params.erosionIterations), 0, 200);
  if (erosionIterations > 0) {
    const thermalPasses = Math.min(2, Math.max(1, Math.round(erosionIterations / 60)));
    thermalErode(height, size, thermalPasses, 0.022, 0.5);
    const droplets = Math.min(40000, Math.round(erosionIterations * size * 0.04));
    hydraulicErode(height, size, droplets, seed, erosionIterations);
    if (model === "plates") {
      streamPowerErode(height, size, erosionIterations, seed);
    }
  }

  if (model === "plates") {
    // Erosion leaves shallow pits behind; left alone they all become lakes in
    // the hydrology stage (v0.5 shipped 6% lake cover and single lakes of 16k
    // cells). Fill the shallow ones cheaply so only real basins remain.
    fillShallowPits(height, size, 3);
    // Quantile calibration: keep the seaLevel slider meaningful across seeds
    // (the plate model's raw distribution drifts a few points otherwise).
    calibrateLandFraction(height, size, params.seaLevel, 0.40);
  }

  // Fractal coastline detail runs LAST on purpose: hydraulic/thermal erosion
  // smooths any sub-cell jitter, so roughening before it left coasts looking
  // like smooth polygons (box dimension ~1.10 instead of 1.2+).
  if (model === "plates" || modernTerrain) roughenCoast(height, size, seed);

  if (modernTerrain) {
    // Interior basins that sit below sea level would either flood as giant
    // lakes or violate the "below sea level is always water" invariant. Raise
    // them just above the waterline; border-connected water stays as ocean.
    raiseInteriorBasins(height, size, params.seaLevel);
  }

  // ── Brush overrides (before hydrology fills depressions) ───────────────
  applyElevationStamps(height, size, overrides?.elevation);
  const channel = carveRiverForce(height, size, overrides?.riverForce);

  for (let i = 0; i < n; i += 1) {
    const h = height[i];
    height[i] = Number.isFinite(h) ? (h < 0 ? 0 : h > 1 ? 1 : h) : 0;
  }

  return platesFrom(model, plateModel, height, channel);
}

/** In-place 3x3 binomial smoothing pass (plate base seam removal). */
function smoothField(field: Float32Array, size: number, passes: number): void {
  if (passes <= 0) return;
  const cells = size * size;
  const scratch = new Float32Array(cells);
  for (let pass = 0; pass < passes; pass += 1) {
    scratch.set(field);
    for (let y = 1; y < size - 1; y += 1) {
      const row = y * size;
      for (let x = 1; x < size - 1; x += 1) {
        const i = row + x;
        field[i] =
          (scratch[i] * 4 +
            scratch[i - 1] +
            scratch[i + 1] +
            scratch[i - size] +
            scratch[i + size]) /
          8;
      }
    }
  }
}

/**
 * Flood-fill from the map border over cells below `seaLevel`; every below-sea
 * cell that is NOT border-connected is an interior basin and gets lifted just
 * above the waterline (so hydrology never has to invent a giant lake there).
 */
export function raiseInteriorBasins(height: Float32Array, size: number, seaLevel: number): void {
  const cells = size * size;
  const borderConnected = new Uint8Array(cells);
  const queue = new Int32Array(cells);
  let head = 0;
  let tail = 0;
  const push = (cell: number) => {
    if (borderConnected[cell]) return;
    if (height[cell] >= seaLevel) return;
    borderConnected[cell] = 1;
    queue[tail++] = cell;
  };
  for (let x = 0; x < size; x += 1) {
    push(x);
    push((size - 1) * size + x);
  }
  for (let y = 0; y < size; y += 1) {
    push(y * size);
    push(y * size + size - 1);
  }
  while (head < tail) {
    const cell = queue[head++];
    const x = cell % size;
    const y = (cell / size) | 0;
    if (x > 0) push(cell - 1);
    if (x < size - 1) push(cell + 1);
    if (y > 0) push(cell - size);
    if (y < size - 1) push(cell + size);
  }
  const lift = seaLevel + 0.002;
  for (let i = 0; i < cells; i += 1) {
    if (!borderConnected[i] && height[i] < seaLevel) height[i] = lift;
  }
}

function platesFrom(
  model: TerrainModel,
  plateModel: PlateModel | undefined,
  height: Float32Array,
  channel: Uint8Array,
): TerrainResult {
  if (model === "plates" && plateModel) {
    return { height, channel, plates: { id: plateModel.id, count: plateModel.count } };
  }
  return { height, channel };
}

// ── Legacy fBm terrain (v0.4 behaviour, kept bit-for-bit) ──────────────────

function buildFbmHeight(
  height: Float32Array,
  size: number,
  seed: number,
  params: WorldParams,
): void {
  const warpRes = fieldRes(size, 160);
  const warpAmp = clamp01(params.warpStrength) * 0.13;
  const warpX = buildField(warpRes, (u, v) => fbm(u * 2.3 + 3.7, v * 2.3 + 8.1, seed + 101, 3) - 0.5);
  const warpY = buildField(warpRes, (u, v) => fbm(u * 2.3 - 5.3, v * 2.3 + 1.9, seed + 211, 3) - 0.5);

  const contRes = fieldRes(size, 384);
  const contFreq = 1.55 * clamp(params.continentScale, 0.25, 4);
  const continent = buildField(contRes, (u, v) => fbm(u * contFreq + 3.1, v * contFreq + 7.7, seed, 5) - 0.5);

  const ridgeRes = fieldRes(size, 384);
  const ridgeFreq = 3.4 * clamp(params.ridgeScale, 0.4, 5);
  const ridges = buildField(ridgeRes, (u, v) => {
    const mask = smoothstep01((fbm(u * 1.45 + 11.3, v * 1.45 + 2.7, seed + 401, 3) - 0.28) * 1.9);
    return ridgedMultifractal(u * ridgeFreq, v * ridgeFreq, seed + 307, 4, 2, 0.5) * (0.25 + 0.75 * mask);
  });

  const detailRes = fieldRes(size, 256);
  const detail = buildField(detailRes, (u, v) => fbm(u * 22 + 5.9, v * 22 + 13.1, seed + 509, 2) - 0.5);

  const invSize = 1 / size;
  const ridgeAmp = clamp01(params.ridgeStrength) * 0.62;

  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) * invSize;
    const row = y * size;
    const dy = v * 2 - 1;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * invSize;
      const dx = u * 2 - 1;

      const wxo = sampleField(warpX, warpRes, u, v) * warpAmp * 2;
      const wyo = sampleField(warpY, warpRes, u, v) * warpAmp * 2;
      const wu = u + wxo;
      const wv = v + wyo;

      const cont = sampleField(continent, contRes, wu, wv);
      const ridge = sampleField(ridges, ridgeRes, wu, wv);
      const fine = sampleField(detail, detailRes, u, v);

      let h = 0.5 + cont * 1.35;
      const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const fall = smoothstep01((dist - 0.3) / 0.62) * clamp01(params.continentality);
      h -= fall * 0.98;
      const mountain = ridge * ridgeAmp * (0.45 + 0.55 * clamp01(0.5 + cont * 1.2));
      h += mountain;
      h += fine * 0.11;

      height[row + x] = h;
    }
  }
}

// ── v0.5 plate terrain ────────────────────────────────────────────────────

function buildPlateHeight(
  height: Float32Array,
  size: number,
  seed: number,
  params: WorldParams,
  plate: PlateModel,
): void {
  // Two warp octaves: a broad domain warp for organic continents plus a
  // mid-frequency warp that keeps plate boundaries from crossing the sea level
  // as straight Voronoi segments.
  const warpRes = fieldRes(size, 200);
  const warpAmp = 0.05 + clamp01(params.warpStrength) * 0.12;
  const warpX = buildField(warpRes, (u, v) => fbm(u * 2.3 + 3.7, v * 2.3 + 8.1, seed + 101, 3) - 0.5);
  const warpY = buildField(warpRes, (u, v) => fbm(u * 2.3 - 5.3, v * 2.3 + 1.9, seed + 211, 3) - 0.5);
  const warp2Res = fieldRes(size, 256);
  const warp2Amp = 0.035 + clamp01(params.warpStrength) * 0.03;
  const warp2X = buildField(warp2Res, (u, v) => fbm(u * 6.8 + 1.9, v * 6.8 + 4.7, seed + 1201, 2) - 0.5);
  const warp2Y = buildField(warp2Res, (u, v) => fbm(u * 6.8 - 7.1, v * 6.8 + 2.3, seed + 1301, 2) - 0.5);

  const ridgeRes = fieldRes(size, 384);
  const ridgeFreq = 3.4 * clamp(params.ridgeScale, 0.4, 5);
  const ridge = buildField(ridgeRes, (u, v) =>
    ridgedMultifractal(u * ridgeFreq + 4.1, v * ridgeFreq + 9.7, seed + 307, 5, 2, 0.55),
  );
  // Lower-frequency ridge modulation -> 2-3 parallel crests along a belt
  // instead of one uniform white band.
  const strikeRes = fieldRes(size, 320);
  const strike = buildField(strikeRes, (u, v) =>
    ridgedMultifractal(u * ridgeFreq * 0.48 + 7.3, v * ridgeFreq * 0.48 + 2.1, seed + 613, 4, 2, 0.5),
  );

  const intraRes = fieldRes(size, 192);
  const intra = buildField(intraRes, (u, v) => fbm(u * 1.35 + 2.9, v * 1.35 + 6.3, seed + 701, 3) - 0.5);

  // v0.5.1: continent shape comes from the fBm field that produced the v0.4.1
  // coastlines (organic, non-polygonal), while plate boundaries drive where
  // mountains form. The plate base bias only nudges the field.
  const contRes = fieldRes(size, 384);
  const contFreq = 1.55 * clamp(params.continentScale, 0.25, 4);
  const continent = buildField(contRes, (u, v) => fbm(u * contFreq + 3.1, v * contFreq + 7.7, seed, 5) - 0.5);
  const detailRes = fieldRes(size, 512);
  const detail = buildField(detailRes, (u, v) =>
    fbm(u * 22 + 5.9, v * 22 + 13.1, seed + 509, 3) * 0.6 +
    fbm(u * 61 + 2.7, v * 61 + 8.3, seed + 557, 2) * 0.4 -
    0.5,
  );

  // Full-resolution smoothing of the (already blurred) plate base: removes the
  // residual seam so ridgelines, not plate edges, dominate the relief.
  smoothField(plate.baseField, size, 2);

  const invSize = 1 / size;
  const continentality = clamp01(params.continentality);
  const ridgeStrength = clamp01(params.ridgeStrength);
  const mountainAmp = 0.22 + 1.15 * ridgeStrength;

  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) * invSize;
    const row = y * size;
    const dy = v * 2 - 1;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * invSize;
      const dx = u * 2 - 1;

      // Warped sampling gets organic coastlines while plate boundaries stay
      // crisp thanks to exact ownership lookup in the plate model.
      const wxo =
        sampleField(warpX, warpRes, u, v) * warpAmp * 2 +
        sampleField(warp2X, warp2Res, u, v) * warp2Amp * 2;
      const wyo =
        sampleField(warpY, warpRes, u, v) * warpAmp * 2 +
        sampleField(warp2Y, warp2Res, u, v) * warp2Amp * 2;
      const wu = u + wxo;
      const wv = v + wyo;

      const owner = plateIdAt(plate.id, size, wu, wv);
      const boundary = sampleField(plate.boundary, size, wu, wv);
      const convergent = sampleField(plate.convergence, size, wu, wv);
      const divergent = sampleField(plate.divergence, size, wu, wv);
      const intraNoise = sampleField(intra, intraRes, u, v);
      const detailNoise = sampleField(detail, detailRes, u, v);
      const ridged = sampleField(ridge, ridgeRes, wu, wv);
      const strikeNoise = sampleField(strike, strikeRes, wu, wv);

      // Plate base elevation (smoothed across boundaries) + weak intra-plate
      // undulation so continents are not flat "cotton" plates.
      // Sample the smoothed plate base *at the warped coordinates* so the
      // continental/oceanic transition (and therefore the coast) meanders
      // instead of following the Voronoi boundary.
      const cont = sampleField(continent, contRes, wu, wv);
      const plateBias = sampleField(plate.baseField, size, wu, wv);
      let h = 0.5 + cont * 1.35 + plateBias * 0 + intraNoise * 0.1;
      void plateBias;

      // Convergent boundaries -> mountain belts. The belt mask is non-uniform
      // (closeness^1.15 * motion strength * local variation) and the uplift is
      // multiplied by two ridged fields so the result is a chain of peaks, not
      // a uniform white band.
      const continentalSide = plate.continental[owner] === 1 ? 1 : 0.45;
      const beltVariation = 0.55 + 0.45 * clamp01(0.5 + intraNoise * 1.8);
      // Orogenic belts: gaussian distance mask around convergent boundaries
      // (plates.ts) x ridged peaks. This reads as a chain of ranges with
      // passes, instead of the triangular wedge a Voronoi closeness field gives.
      const belt = plate.beltMask[owner];
      const alongStrike = clamp01(0.4 + 0.95 * strikeNoise) * (0.55 + 0.45 * clamp01(0.5 + intraNoise * 1.4));
      const peakProfile = 0.15 + 1.0 * Math.pow(ridged, 1.8);
      h += belt * peakProfile * alongStrike * continentalSide * beltVariation * mountainAmp * 1.15;

      // Divergent boundaries -> rifts (continents) / mid-ocean ridge (ocean).
      h -= boundary * divergent * (plate.continental[owner] === 1 ? 0.22 : 0.05);
      if (plate.continental[owner] === 0) {
        h += boundary * divergent * 0.04 * (0.5 + 0.5 * ridged);
      }

      // Transform boundaries -> gentle linear fabric.
      const transform = clamp01(1 - convergent - divergent);
      h += boundary * transform * (detailNoise + 0.5) * 0.025;

      // Continental shelf / slope: oceanic plates sit lower and fall away.
      h -= (1 - plate.continental[owner]) * 0.04;

      const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const fall = smoothstep01((dist - 0.3) / 0.62) * continentality;
      h -= fall * 0.98;

      // Multi-scale relief: plate interiors must not read as smooth plateaus.
      h += intraNoise * 0.12 + detailNoise * 0.15;

      height[row + x] = h;
    }
  }
}

/**
 * Coastal roughening (plates model): a small multi-scale height perturbation
 * added after distribution calibration, slightly stronger around the typical
 * waterline. This breaks straight Voronoi sea-level crossings into fractal
 * coastlines without changing the overall composition.
 */
function roughenCoast(height: Float32Array, size: number, seed: number): void {
  // Two-scale domain warp applied to the perturbation coordinates: straight
  // fBm jitter produces rounded blobs, whereas warped noise carves inlets,
  // headlands and offshore islets (the box-counting dimension rises from
  // ~1.10 to 1.2+ while the macro shape is preserved).
  const warpRes = fieldRes(size, 256);
  const warpX = buildField(warpRes, (u, v) => fbm(u * 4.7 + 2.3, v * 4.7 + 8.9, seed + 1451, 3) - 0.5);
  const warpY = buildField(warpRes, (u, v) => fbm(u * 4.7 + 6.1, v * 4.7 + 1.7, seed + 1471, 3) - 0.5);

  const macroRes = fieldRes(size, 512);
  const macro = buildField(macroRes, (u, v) => fbm(u * 11 + 3.1, v * 11 + 7.7, seed + 1501, 3) - 0.5);
  const midRes = fieldRes(size, 512);
  const mid = buildField(midRes, (u, v) => fbm(u * 29 + 5.9, v * 29 + 2.3, seed + 1551, 4) - 0.5);
  const microRes = fieldRes(size, 512);
  const micro = buildField(microRes, (u, v) => fbm(u * 73 + 1.3, v * 73 + 9.1, seed + 1601, 3) - 0.5);
  const fineRes = fieldRes(size, 512);
  const fine = buildField(fineRes, (u, v) => fbm(u * 151 + 4.9, v * 151 + 6.3, seed + 1661, 2) - 0.5);

  const inv = 1 / size;
  const warpAmp = 0.02;
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) * inv;
    const row = y * size;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) * inv;
      const h = height[row + x];
      // Only the coastal band gets the full perturbation; deep interior and
      // open ocean are left alone so relief and sea-floor stay intact.
      const dist = Math.abs(h - 0.42);
      if (dist > 0.22) continue;
      const band = Math.exp(-((dist / 0.13) ** 2));
      const wu = u + sampleField(warpX, warpRes, u, v) * warpAmp;
      const wv = v + sampleField(warpY, warpRes, u, v) * warpAmp;
      const jag =
        sampleField(macro, macroRes, wu, wv) * 0.095 +
        sampleField(mid, midRes, wu, wv) * 0.075 +
        sampleField(micro, microRes, wu, wv) * 0.058 +
        sampleField(fine, fineRes, u, v) * 0.042;
      height[row + x] = clamp01(h + jag * band);
    }
  }
}

/**
 * Cheap pit filling: repeatedly raise a cell that is a strict local minimum to
 * the minimum of its 8-neighbourhood. Runs in O(passes * n) and only removes
 * one-cell / few-cell pits left by hydraulic + stream-power erosion, so genuine
 * basins (which span many cells) survive and still become lakes.
 */
export function fillShallowPits(height: Float32Array, size: number, passes: number): void {
  const cells = size * size;
  const scratch = new Float32Array(cells);
  for (let pass = 0; pass < passes; pass += 1) {
    scratch.set(height);
    let changed = 0;
    for (let y = 1; y < size - 1; y += 1) {
      for (let x = 1; x < size - 1; x += 1) {
        const i = y * size + x;
        const h = scratch[i];
        let lowest = Infinity;
        for (let k = 0; k < 8; k += 1) {
          const n = (y + (k === 0 ? -1 : k === 1 ? 1 : k === 2 ? 0 : k === 3 ? 0 : k === 4 ? -1 : k === 5 ? 1 : k === 6 ? -1 : 1)) * size +
            (x + (k === 0 ? 0 : k === 1 ? 0 : k === 2 ? -1 : k === 3 ? 1 : k === 4 ? -1 : k === 5 ? -1 : k === 6 ? 1 : 1));
          const nh = scratch[n];
          if (nh < lowest) lowest = nh;
        }
        if (h < lowest - 1e-5) {
          // Lift to just below the lowest neighbour: the cell stops being a pit
          // but keeps a downhill path.
          height[i] = lowest - 1e-5;
          changed += 1;
        }
      }
    }
    if (changed === 0) break;
  }
}

/**
 * Shift the height field so that `targetLandFraction` of cells sit above
 * `seaLevel`. Used by the plate model so the seaLevel parameter keeps the same
 * meaning it had for the legacy model (default 0.42 -> ~40% land).
 */
export function calibrateLandFraction(
  height: Float32Array,
  size: number,
  seaLevel: number,
  targetLandFraction: number,
): void {
  const cells = size * size;
  // Histogram over 4096 buckets is plenty for a shift calibration.
  const buckets = 4096;
  const hist = new Int32Array(buckets);
  for (let i = 0; i < cells; i += 1) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(height[i] * (buckets - 1))));
    hist[b] += 1;
  }
  const targetWater = Math.round(cells * (1 - targetLandFraction));
  let accumulated = 0;
  let thresholdBucket = buckets - 1;
  for (let b = 0; b < buckets; b += 1) {
    accumulated += hist[b];
    if (accumulated >= targetWater) {
      thresholdBucket = b;
      break;
    }
  }
  const threshold = thresholdBucket / (buckets - 1);
  const shift = seaLevel - threshold;
  if (Math.abs(shift) < 1e-4) return;
  for (let i = 0; i < cells; i += 1) {
    height[i] = Math.min(1, Math.max(0, height[i] + shift));
  }
}

// ── Distribution calibration + ocean border ───────────────────────────────

function normalizeHeight(height: Float32Array, size: number): void {
  const n = size * size;
  const edgeWidth = Math.max(2, size * 0.035);
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
}

/**
 * Stream-power erosion (v0.5): fill depressions once, route D8 + accumulate,
 * then apply dh ∝ A^0.5 · S for a bounded number of rounds, with alluvial
 * deposition on low-slope downstream cells. Ridges are (structurally) safe:
 * their drainage area A ≈ 1, so incision concentrates in channels.
 */
export function streamPowerErode(
  height: Float32Array,
  size: number,
  erosionIterations: number,
  seed: number,
): void {
  const cells = size * size;
  const rounds = clamp(Math.round(erosionIterations / 5), 4, 24);
  const drainage = computeDrainage(size, height);
  const { downstream, accumulation } = drainage;
  const deposition = new Float32Array(cells);
  const rng = makeRng((seed ^ 0x5bd1e995) >>> 0);
  const baseK = 0.0021;

  for (let round = 0; round < rounds; round += 1) {
    deposition.fill(0);
    // Vary the coefficient slightly per round (deterministic) to avoid
    // uniform slicing artefacts.
    const k = baseK * (0.85 + 0.3 * rng());
    for (let i = 0; i < cells; i += 1) {
      const d = downstream[i];
      if (d < 0) continue;
      const h = height[i];
      if (h <= 0.02) continue;
      const slope = h - height[d];
      if (slope <= 0.0004) continue;
      const area = accumulation[i];
      if (area < 2.5) continue; // ridge/divide cells are not channels
      let erode = k * Math.sqrt(area) * slope;
      if (erode > slope * 0.28) erode = slope * 0.28;
      if (erode > 0.02) erode = 0.02;
      if (h < 0.08) erode *= h / 0.08;
      height[i] = h - erode;
      // Alluvium: deposit half of the load on flat valley floors, some on
      // steeper reaches so material keeps moving downstream.
      const downSlope = Math.max(0, height[d] - (d >= 0 ? height[d] : 0));
      void downSlope;
      const localSlope = Math.abs(height[d] - (height[d + 1] ?? height[d]));
      if (slope < 0.006) deposition[d] += erode * 0.5;
      else deposition[d] += erode * 0.12;
      void localSlope;
    }
    for (let i = 0; i < cells; i += 1) {
      if (deposition[i] > 0) height[i] = clamp01(height[i] + deposition[i]);
    }
  }
  for (let i = 0; i < cells; i += 1) height[i] = clamp01(height[i]);
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

