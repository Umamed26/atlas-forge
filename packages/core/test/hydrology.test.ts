import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline } from "../src/index";
import type { WorldLayers } from "../src/types";

const NX = [-1, 1, 0, 0, -1, 1, -1, 1];
const NY = [0, 0, -1, 1, -1, -1, 1, 1];

interface Violation {
  seed: number;
  kind: string;
  at?: number;
  detail?: string;
}

/** Follow steepest descent on the filled surface until water is reached. */
function descendToWater(
  layers: WorldLayers,
  start: number,
): { ok: boolean; steps: number; kind: string } {
  const size = layers.size;
  const maxSteps = size * 4 + 16;
  let cell = start;
  for (let step = 0; step < maxSteps; step += 1) {
    if (layers.ocean[cell]) return { ok: true, steps: step, kind: "ocean" };
    if (layers.lake[cell]) return { ok: true, steps: step, kind: "lake" };
    const x = cell % size;
    const y = (cell / size) | 0;
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
      return { ok: false, steps: step, kind: "dry-border" };
    }
    const h = layers.filled[cell];
    let best = -1;
    let bestFilled = h;
    for (let k = 0; k < 8; k += 1) {
      const nIndex = (y + NY[k]) * size + (x + NX[k]);
      const f = layers.filled[nIndex];
      if (f < bestFilled) {
        bestFilled = f;
        best = nIndex;
      }
    }
    if (best < 0) return { ok: false, steps: step, kind: "dead-end" };
    cell = best;
  }
  return { ok: false, steps: maxSteps, kind: "too-long" };
}

function inspect(seed: number, size: number): { violations: Violation[]; layers: WorldLayers } {
  const document = createDefaultDocument({ seed, params: { gridSize: size } });
  const layers = createPipeline().generate({ document, size });
  const seaLevel = document.params.seaLevel;
  const violations: Violation[] = [];
  const count = size * size;

  for (let i = 0; i < count; i += 1) {
    if (!Number.isFinite(layers.height[i]) || !Number.isFinite(layers.filled[i])) {
      violations.push({ seed, kind: "non-finite-fill", at: i });
      break;
    }
    if (layers.filled[i] < layers.height[i] - 1e-6) {
      violations.push({ seed, kind: "filled-below-height", at: i });
      break;
    }
  }

  // Every interior land cell drains: a strictly lower 8-neighbour must exist on
  // the filled surface (Priority-Flood property).
  outer: for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      const h = layers.filled[i];
      let lower = false;
      for (let k = 0; k < 8; k += 1) {
        if (layers.filled[(y + NY[k]) * size + (x + NX[k])] < h) {
          lower = true;
          break;
        }
      }
      if (!lower) {
        violations.push({ seed, kind: "no-downhill-neighbour", at: i, detail: `${x},${y}` });
        break outer;
      }
    }
  }

  // Sea level rules: below-sea cells must be water; ocean must be below sea;
  // lake surfaces are above sea level; rivers are dry-land features.
  for (let i = 0; i < count; i += 1) {
    if (layers.height[i] < seaLevel && !layers.ocean[i] && !layers.lake[i]) {
      violations.push({ seed, kind: "below-sea-not-water", at: i });
      break;
    }
    if (layers.ocean[i] && layers.filled[i] >= seaLevel) {
      violations.push({ seed, kind: "ocean-above-sea-level", at: i });
      break;
    }
    if (layers.lake[i] && layers.filled[i] < seaLevel) {
      violations.push({ seed, kind: "lake-below-sea-level", at: i });
      break;
    }
    if (layers.river[i] && (layers.ocean[i] || layers.lake[i])) {
      violations.push({ seed, kind: "river-on-water", at: i });
      break;
    }
  }

  // Rivers: no back-flow, no dead ends, terminal at sea/lake.
  for (let i = 0; i < count; i += 1) {
    if (!layers.river[i]) continue;
    const result = descendToWater(layers, i);
    if (!result.ok) {
      violations.push({ seed, kind: `river-${result.kind}`, at: i });
      break;
    }
  }

  // Lakes: every lake cell connects downhill to the open sea/lake outlet.
  for (let i = 0; i < count; i += 1) {
    if (!layers.lake[i]) continue;
    const result = descendToWater(layers, i);
    if (!result.ok) {
      violations.push({ seed, kind: `lake-${result.kind}`, at: i });
      break;
    }
  }

  return { violations, layers };
}

describe("hydrology invariants across seeds", () => {
  const SEEDS = Array.from({ length: 30 }, (_, k) => 1000 + k * 7919 + 17);
  const SIZE = 192;

  it("keeps water flowing downhill for 30 seeds: no back-flow, no dead ends, terminal at sea/lake", () => {
    const violations: Violation[] = [];
    for (const seed of SEEDS) {
      const result = inspect(seed, SIZE);
      violations.push(...result.violations);
      if (violations.length > 0) break;
    }
    expect(violations.slice(0, 6)).toEqual([]);
  });

  it("has both ocean and land in every seed", () => {
    for (const seed of SEEDS.slice(0, 12)) {
      const document = createDefaultDocument({ seed, params: { gridSize: SIZE } });
      const layers = createPipeline().generate({ document, size: SIZE });
      expect(layers.stats.landFraction).toBeGreaterThan(0.02);
      expect(layers.stats.landFraction).toBeLessThan(0.98);
    }
  });

  it("scales river density with the riverDensity parameter", () => {
    const size = 256;
    const countRivers = (riverDensity: number): number => {
      const document = createDefaultDocument({
        seed: 2026,
        params: { gridSize: size, riverDensity },
      });
      const layers = createPipeline().generate({ document, size });
      let rivers = 0;
      for (let i = 0; i < layers.river.length; i += 1) rivers += layers.river[i];
      return rivers;
    };
    const sparse = countRivers(0.05);
    const dense = countRivers(0.95);
    expect(dense).toBeGreaterThan(sparse * 1.5);
  });

  it("produces lakes with a downhill outlet on at least one seed", () => {
    let totalLakes = 0;
    for (const seed of SEEDS.slice(0, 8)) {
      const result = inspect(seed, SIZE);
      for (let i = 0; i < result.layers.lake.length; i += 1) totalLakes += result.layers.lake[i];
      expect(result.violations).toEqual([]);
    }
    expect(totalLakes).toBeGreaterThan(0);
  });
});
