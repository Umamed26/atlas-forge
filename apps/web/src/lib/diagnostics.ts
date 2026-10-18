/**
 * World diagnostics (v0.5): derive "credibility" numbers from the existing
 * layers, never triggering an extra generation. riverOrder-based metrics light
 * up as soon as core ships `WorldLayers.riverOrder`.
 */
import {
  BIOME_NAMES,
  type BiomeId,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";

import { BIOME_COLORS } from "./constants";

export interface DiagnosticsLayerMetrics {
  size: number;
  landFraction: number;
  elevationAvg: number | null;
  elevationMax: number | null;
  plateCount: number | null;
  ridgeShare: number | null;
  riverCells: number;
  lakeCells: number;
  riverCount: number | null;
  strahlerMax: number | null;
  longestRiverCells: number | null;
  hangingRiverRate: number | null;
  driest: { label: string; value: number } | null;
  wettest: { label: string; value: number } | null;
  biomeShares: { id: BiomeId; name: string; color: string; share: number }[];
  biomeKinds: number;
  stageMs: {
    terrain: number;
    hydrology: number;
    climate: number;
    biome: number;
    human: number;
    total: number;
  } | null;
}

interface LayersWithAlgorithmExtras extends WorldLayers {
  plateBoundaryRidges?: Uint8Array;
  boundaryRidgeShare?: number;
  plateCount?: number;
}

const SAMPLE_STEP = 7;

function nearestLabelName(layers: WorldLayers, index: number): string {
  const size = layers.size;
  const x = (index % size) / size;
  const y = Math.floor(index / size) / size;
  let best: { name: string; distance: number } | null = null;
  for (const label of layers.autoLabels ?? []) {
    const dx = label.x - x;
    const dy = label.y - y;
    const distance = dx * dx + dy * dy;
    if (!best || distance < best.distance) best = { name: label.text, distance };
  }
  for (const settlement of layers.settlements ?? []) {
    const dx = settlement.x - x;
    const dy = settlement.y - y;
    const distance = dx * dx + dy * dy;
    if (!best || distance < best.distance) best = { name: settlement.name, distance };
  }
  return best?.name ?? "未知区域";
}

export function computeDiagnostics(
  document: WorldDocument,
  layers: WorldLayers | null,
): DiagnosticsLayerMetrics | null {
  if (!layers) return null;
  const extended = layers as LayersWithAlgorithmExtras;
  const size = layers.size;
  const cells = size * size;

  let landCells = 0;
  let heightSum = 0;
  let heightMax = 0;
  let heightSamples = 0;
  let riverCells = 0;
  let lakeCells = 0;
  let riverCount = 0;
  let strahlerMax = 0;
  let riverEndpoints = 0;
  let hangingEndpoints = 0;
  let driestIndex = -1;
  let wettestIndex = -1;
  let driestValue = Number.POSITIVE_INFINITY;
  let wettestValue = Number.NEGATIVE_INFINITY;
  const biomeCounts = new Map<number, number>();
  const order = extended.riverOrder;
  const boundaryRidges = extended.plateBoundaryRidges;
  let boundaryRidgeCells = 0;
  let boundarySamples = 0;

  for (let index = 0; index < cells; index += 1) {
    const ocean = layers.ocean[index] === 1;
    if (!ocean) {
      landCells += 1;
      const height = layers.height[index];
      heightSum += height;
      heightSamples += 1;
      if (height > heightMax) heightMax = height;
      const moisture = layers.moisture[index];
      if (moisture < driestValue) {
        driestValue = moisture;
        driestIndex = index;
      }
      if (moisture > wettestValue) {
        wettestValue = moisture;
        wettestIndex = index;
      }
      const biome = layers.biome[index];
      biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
    }
    if (layers.lake[index] === 1) lakeCells += 1;
    if (layers.river[index] === 1) {
      riverCells += 1;
      if (index === 0 || layers.river[index - 1] === 0) riverCount += 1;
      if (order) {
        const riverOrderValue = Math.round(order[index]);
        if (riverOrderValue > strahlerMax) strahlerMax = riverOrderValue;
      }
      // Hanging river = a river endpoint (<=1 river neighbour) whose lowest
      // downstream neighbour is dry land at the same/lower filled height. A
      // healthy hydrology pass should leave ~0% of endpoints stranded inland.
      const x = index % size;
      const y = (index - x) / size;
      let riverNeighbours = 0;
      let touchesWater = false;
      let lowestNeighbour = -1;
      let lowestHeight = Number.POSITIVE_INFINITY;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          const neighbor = ny * size + nx;
          if (layers.river[neighbor] === 1) riverNeighbours += 1;
          if (layers.ocean[neighbor] === 1 || layers.lake[neighbor] === 1) {
            touchesWater = true;
          }
          const neighborHeight = layers.filled[neighbor];
          if (neighborHeight < lowestHeight) {
            lowestHeight = neighborHeight;
            lowestNeighbour = neighbor;
          }
        }
      }
      if (riverNeighbours <= 1) {
        riverEndpoints += 1;
        if (
          !touchesWater &&
          lowestNeighbour >= 0 &&
          layers.ocean[lowestNeighbour] !== 1 &&
          layers.lake[lowestNeighbour] !== 1 &&
          lowestHeight >= layers.filled[index]
        ) {
          hangingEndpoints += 1;
        }
      }
    }
    if (boundaryRidges && index % SAMPLE_STEP === 0) {
      boundarySamples += 1;
      if (boundaryRidges[index]) boundaryRidgeCells += 1;
    }
  }

  const landFraction = cells > 0 ? landCells / cells : layers.stats.landFraction;
  const biomeShares = [...biomeCounts.entries()]
    .map(([id, count]) => ({
      id: id as BiomeId,
      name: BIOME_NAMES[id as BiomeId] ?? `群系 ${id}`,
      color: BIOME_COLORS[id as BiomeId] ?? "#8a8577",
      share: landCells > 0 ? count / landCells : 0,
    }))
    .sort((a, b) => b.share - a.share);

  const biomeKinds = biomeCounts.size;
  const plateCount =
    typeof extended.plateCount === "number"
      ? extended.plateCount
      : typeof extended.plates?.count === "number"
        ? extended.plates.count
        : null;
  const ridgeShare =
    typeof extended.boundaryRidgeShare === "number"
      ? extended.boundaryRidgeShare
      : boundaryRidges && boundarySamples > 0
        ? boundaryRidgeCells / boundarySamples
        : null;

  return {
    size,
    landFraction,
    elevationAvg: heightSamples > 0 ? heightSum / heightSamples : null,
    elevationMax: heightSamples > 0 ? heightMax : null,
    plateCount,
    ridgeShare,
    riverCells,
    lakeCells,
    riverCount: riverCells > 0 ? riverCount : 0,
    strahlerMax: order ? strahlerMax : null,
    longestRiverCells: order && strahlerMax > 0 ? strahlerMax : null,
    hangingRiverRate:
      riverEndpoints > 0 ? hangingEndpoints / riverEndpoints : null,
    driest:
      driestIndex >= 0
        ? { label: nearestLabelName(layers, driestIndex), value: driestValue }
        : null,
    wettest:
      wettestIndex >= 0
        ? { label: nearestLabelName(layers, wettestIndex), value: wettestValue }
        : null,
    biomeShares,
    biomeKinds,
    stageMs: layers.stats
      ? {
          terrain: layers.stats.terrainMs,
          hydrology: layers.stats.hydrologyMs,
          climate: layers.stats.climateMs,
          biome: layers.stats.biomeMs,
          human: layers.stats.humanMs,
          total: layers.stats.totalMs,
        }
      : null,
  };
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** Fixed docs reference used only to prove the adapter compiles against the type. */
export type { WorldDocument };
