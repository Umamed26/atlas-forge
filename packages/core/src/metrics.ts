/**
 * Physical readability metrics for a generated world.
 *
 * Pure function over `WorldLayers`, used by the UI to warn the user when a
 * parameter combination produces an unreadable map (e.g. almost no land, no
 * rivers). Cheap enough to run on every generation (target < 5ms @ 1024²): a
 * single row-major pass that counts river/lake cells, biome kinds and
 * 8-connected river systems (row-run union-find, no full-grid visited array).
 */
import type { WorldLayers } from "./types";

export interface WorldMetricFlags {
  /** Land fraction below the readable minimum (~12%). */
  tooMuchWater: boolean;
  /** Land fraction above the readable maximum (~85%). */
  tooLittleWater: boolean;
  /** No river cell at all. */
  noRivers: boolean;
  /** Fewer than 8 generated settlements. */
  tooSparse: boolean;
  /** More than 80 generated settlements. */
  tooDense: boolean;
  /** Fewer than 3 biome kinds present. */
  lowBiomeDiversity: boolean;
}

export interface WorldMetrics {
  landFraction: number;
  riverCells: number;
  /** Number of connected river systems (8-neighbour components). */
  riverCount: number;
  lakeCells: number;
  settlements: number;
  labels: number;
  biomeKinds: number;
  flags: WorldMetricFlags;
}

// Readability thresholds (shared with the UI copy shown to users).
const MIN_LAND_FRACTION = 0.12;
const MAX_LAND_FRACTION = 0.85;
const MIN_SETTLEMENTS = 8;
const MAX_SETTLEMENTS = 80;
const MIN_BIOME_KINDS = 3;

interface WorldScan {
  riverCells: number;
  lakeCells: number;
  biomeKinds: number;
  riverCount: number;
}

/**
 * Single row-major pass:
 *  - count river/lake cells and distinct biome ids
 *  - count 8-connected river components with per-row runs + union-find
 */
function scanWorld(layers: WorldLayers): WorldScan {
  const size = layers.size;
  const river = layers.river;
  const lake = layers.lake;
  const biome = layers.biome;
  const biomeSeen = new Uint8Array(16);

  // Run ids are small (one per horizontal river run), so a plain array is both
  // cheap and allocation-light; union-find operates on run ids only.
  const parent: number[] = [];
  let runCount = 0;
  let riverCells = 0;
  let lakeCells = 0;

  // Row-run union-find with row tags instead of clearing the label arrays:
  // stale labels from older rows are rejected by the row tag check.
  let previousRun = new Int32Array(size);
  let previousTag = new Uint16Array(size);
  let currentRun = new Int32Array(size);
  let currentTag = new Uint16Array(size);

  const find = (id: number): number => {
    let root = id;
    while (parent[root] !== root) root = parent[root];
    while (parent[id] !== id) {
      const next = parent[id];
      parent[id] = root;
      id = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    const rowTag = (y + 1) & 0xffff;
    let x = 0;
    while (x < size) {
      const index = row + x;
      if (river[index] === 0) {
        if (lake[index] === 1) lakeCells += 1;
        biomeSeen[biome[index]] = 1;
        x += 1;
        continue;
      }
      const startX = x;
      while (x < size && river[row + x] === 1) {
        biomeSeen[biome[row + x]] = 1;
        x += 1;
      }
      const endX = x - 1;
      riverCells += endX - startX + 1;
      const runId = runCount;
      parent[runId] = runId;
      runCount += 1;
      for (let fillX = startX; fillX <= endX; fillX += 1) {
        currentRun[fillX] = runId;
        currentTag[fillX] = rowTag;
      }
      if (y > 0) {
        const fromX = startX > 0 ? startX - 1 : 0;
        const toX = endX < size - 1 ? endX + 1 : size - 1;
        const previousTagValue = y & 0xffff;
        for (let px = fromX; px <= toX; px += 1) {
          if (previousTag[px] !== previousTagValue) continue;
          union(runId, previousRun[px]);
        }
      }
    }
    const swapRun = previousRun;
    previousRun = currentRun;
    currentRun = swapRun;
    const swapTag = previousTag;
    previousTag = currentTag;
    currentTag = swapTag;
  }

  let riverCount = 0;
  for (let id = 0; id < runCount; id += 1) {
    if (find(id) === id) riverCount += 1;
  }
  let biomeKinds = 0;
  for (let b = 0; b < biomeSeen.length; b += 1) {
    if (biomeSeen[b] === 1) biomeKinds += 1;
  }

  return { riverCells, lakeCells, biomeKinds, riverCount };
}

/** Compute readability metrics for a generated world. */
export function assessWorldMetrics(layers: WorldLayers): WorldMetrics {
  const scan = scanWorld(layers);
  const landFraction = layers.stats.landFraction;
  const settlements = layers.settlements.length;
  const labels = layers.autoLabels.length;

  return {
    landFraction,
    riverCells: scan.riverCells,
    riverCount: scan.riverCount,
    lakeCells: scan.lakeCells,
    settlements,
    labels,
    biomeKinds: scan.biomeKinds,
    flags: {
      tooMuchWater: landFraction < MIN_LAND_FRACTION,
      tooLittleWater: landFraction > MAX_LAND_FRACTION,
      noRivers: scan.riverCells === 0,
      tooSparse: settlements < MIN_SETTLEMENTS,
      tooDense: settlements > MAX_SETTLEMENTS,
      lowBiomeDiversity: scan.biomeKinds < MIN_BIOME_KINDS,
    },
  };
}
