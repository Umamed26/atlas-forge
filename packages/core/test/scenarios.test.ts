import { describe, expect, it } from "vitest";
import {
  assessWorldMetrics,
  createDefaultDocument,
  createPipeline,
  getScenarioPreset,
  SCENARIO_PRESETS,
} from "../src/index";
import { DEFAULT_PARAMS, DEFAULT_STYLE } from "../src/defaults";
import type { WorldDocument, WorldLayers } from "../src/types";

const SIZE = 1024;
const SEED = 20261018;

function documentForPreset(index: number, size = SIZE): WorldDocument {
  const preset = SCENARIO_PRESETS[index];
  return createDefaultDocument({
    name: preset.name,
    seed: SEED,
    params: { ...preset.params, gridSize: size },
    style: preset.style,
  });
}

function countRivers(layers: WorldLayers): number {
  let count = 0;
  for (let i = 0; i < layers.river.length; i += 1) count += layers.river[i];
  return count;
}

/** 4-neighbour connected land components (land = not ocean). */
function landComponents(layers: WorldLayers): {
  landFraction: number;
  components: number;
  largestShare: number;
} {
  const size = layers.size;
  const cells = size * size;
  const ocean = layers.ocean;
  const seen = new Uint8Array(cells);
  const queue = new Int32Array(cells);
  let land = 0;
  for (let i = 0; i < cells; i += 1) if (ocean[i] === 0) land += 1;
  let components = 0;
  let largest = 0;
  for (let start = 0; start < cells; start += 1) {
    if (ocean[start] === 1 || seen[start] === 1) continue;
    components += 1;
    let head = 0;
    let tail = 0;
    let count = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const cell = queue[head++];
      count += 1;
      const x = cell % size;
      const y = (cell / size) | 0;
      if (x > 0) {
        const n = cell - 1;
        if (ocean[n] === 0 && seen[n] === 0) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
      if (x < size - 1) {
        const n = cell + 1;
        if (ocean[n] === 0 && seen[n] === 0) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y > 0) {
        const n = cell - size;
        if (ocean[n] === 0 && seen[n] === 0) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
      if (y < size - 1) {
        const n = cell + size;
        if (ocean[n] === 0 && seen[n] === 0) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    if (count > largest) largest = count;
  }
  return {
    landFraction: land / cells,
    components,
    largestShare: land > 0 ? largest / land : 0,
  };
}

describe("scenario presets", () => {
  it("exposes the four lead-defined presets and a lookup helper", () => {
    expect(SCENARIO_PRESETS.map((preset) => preset.id)).toEqual([
      "archipelago",
      "arid-empire",
      "polar-frontier",
      "classic",
    ]);
    for (const preset of SCENARIO_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.tagline.length).toBeGreaterThan(0);
      expect(typeof preset.params).toBe("object");
      expect(typeof preset.style).toBe("object");
      expect(getScenarioPreset(preset.id)).toBe(preset);
    }
    expect(getScenarioPreset("does-not-exist")).toBeUndefined();
  });

  it("keeps the classic preset byte-for-byte equal to DEFAULT_PARAMS/DEFAULT_STYLE", () => {
    const classic = getScenarioPreset("classic");
    expect(classic).toBeDefined();
    expect({ ...DEFAULT_PARAMS, ...classic!.params }).toEqual(DEFAULT_PARAMS);
    expect({ ...DEFAULT_STYLE, ...classic!.style }).toEqual(DEFAULT_STYLE);
  });

  it("generates readable worlds for every preset at 1024²", () => {
    const pipeline = createPipeline();
    for (let index = 0; index < SCENARIO_PRESETS.length; index += 1) {
      const preset = SCENARIO_PRESETS[index];
      const document = documentForPreset(index);
      const layers = pipeline.generate({ document, size: SIZE });
      const metrics = assessWorldMetrics(layers);
      expect(metrics.landFraction, `${preset.id} landFraction`).toBeGreaterThanOrEqual(0.12);
      expect(metrics.landFraction, `${preset.id} landFraction`).toBeLessThanOrEqual(0.85);
      expect(countRivers(layers), `${preset.id} rivers`).toBeGreaterThan(0);
      expect(layers.settlements.length, `${preset.id} settlements`).toBeGreaterThanOrEqual(8);
      expect(layers.settlements.length, `${preset.id} settlements`).toBeLessThanOrEqual(80);
      expect(layers.autoLabels.length, `${preset.id} labels`).toBeGreaterThanOrEqual(12);
      expect(layers.autoLabels.length, `${preset.id} labels`).toBeLessThanOrEqual(60);
      expect(metrics.flags, `${preset.id} flags`).toEqual({
        tooMuchWater: false,
        tooLittleWater: false,
        noRivers: false,
        tooSparse: false,
        tooDense: false,
        lowBiomeDiversity: false,
      });
      console.log(
        `[preset] ${preset.id}: land=${(metrics.landFraction * 100).toFixed(1)}% ` +
          `rivers=${metrics.riverCells}(${metrics.riverCount} systems) ` +
          `settlements=${metrics.settlements} labels=${metrics.labels} biomes=${metrics.biomeKinds}`,
      );
    }
  }, 120_000);

  it("turns the archipelago preset into genuinely separated islands (3 seeds, 512²)", () => {
    const preset = getScenarioPreset("archipelago")!;
    const pipeline = createPipeline();
    for (const seed of [101, 202, 303]) {
      const document = createDefaultDocument({
        name: preset.name,
        seed,
        params: { ...preset.params, gridSize: 512 },
        style: preset.style,
      });
      const layers = pipeline.generate({ document, size: 512 });
      const stats = landComponents(layers);
      console.log(
        `[archipelago] seed ${seed}: land=${(stats.landFraction * 100).toFixed(1)}% ` +
          `islands=${stats.components} largest=${(stats.largestShare * 100).toFixed(0)}%`,
      );
      expect(stats.landFraction, `seed ${seed} land`).toBeGreaterThanOrEqual(0.18);
      expect(stats.landFraction, `seed ${seed} land`).toBeLessThanOrEqual(0.3);
      expect(stats.components, `seed ${seed} island count`).toBeGreaterThanOrEqual(8);
      expect(stats.largestShare, `seed ${seed} largest island`).toBeLessThan(0.45);
    }
    expect(countRivers(pipeline.generate({ document: documentForPreset(0, 512), size: 512 }))).toBeGreaterThan(0);
  }, 120_000);
});

describe("world readability metrics", () => {
  it("reports no flags for a normal world and matches the layer data", () => {
    const document = createDefaultDocument({ seed: SEED, params: { gridSize: 256 } });
    const layers = createPipeline().generate({ document, size: 256 });
    const metrics = assessWorldMetrics(layers);
    expect(metrics.landFraction).toBe(layers.stats.landFraction);
    expect(metrics.settlements).toBe(layers.settlements.length);
    expect(metrics.labels).toBe(layers.autoLabels.length);
    expect(metrics.riverCells).toBe(countRivers(layers));
    expect(metrics.riverCount).toBeGreaterThan(0);
    expect(metrics.lakeCells).toBeGreaterThan(0);
    expect(metrics.biomeKinds).toBeGreaterThanOrEqual(5);
    expect(metrics.flags).toEqual({
      tooMuchWater: false,
      tooLittleWater: false,
      noRivers: false,
      tooSparse: false,
      tooDense: false,
      lowBiomeDiversity: false,
    });
  });

  it("flags extreme sea levels (almost all water / almost no water)", () => {
    const allWater = createPipeline().generate({
      document: createDefaultDocument({ seed: SEED, params: { gridSize: 256, seaLevel: 0.95 } }),
      size: 256,
    });
    const allWaterMetrics = assessWorldMetrics(allWater);
    expect(allWaterMetrics.flags.tooMuchWater).toBe(true);
    expect(allWaterMetrics.flags.noRivers).toBe(true);

    const allLand = createPipeline().generate({
      document: createDefaultDocument({ seed: SEED, params: { gridSize: 256, seaLevel: 0.05 } }),
      size: 256,
    });
    const allLandMetrics = assessWorldMetrics(allLand);
    expect(allLandMetrics.flags.tooLittleWater).toBe(true);
    expect(allLandMetrics.flags.tooMuchWater).toBe(false);
  });

  it("is a pure function: repeated calls return equal metrics without mutating layers", () => {
    const document = createDefaultDocument({ seed: SEED, params: { gridSize: 256 } });
    const layers = createPipeline().generate({ document, size: 256 });
    const before = JSON.stringify({
      stats: layers.stats,
      river: Array.from(layers.river.slice(0, 500)),
      biome: Array.from(layers.biome.slice(0, 500)),
    });
    const first = assessWorldMetrics(layers);
    const second = assessWorldMetrics(layers);
    expect(second).toEqual(first);
    const after = JSON.stringify({
      stats: layers.stats,
      river: Array.from(layers.river.slice(0, 500)),
      biome: Array.from(layers.biome.slice(0, 500)),
    });
    expect(after).toBe(before);
  });

  it("assesses a 1024² world in under 5ms (best of five)", () => {
    const preset = getScenarioPreset("classic")!;
    const layers = createPipeline().generate({
      document: createDefaultDocument({
        seed: SEED,
        params: { ...preset.params, gridSize: SIZE },
      }),
      size: SIZE,
    });
    assessWorldMetrics(layers); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const startedAt = performance.now();
      assessWorldMetrics(layers);
      times.push(performance.now() - startedAt);
    }
    const best = Math.min(...times);
    console.log(
      `[metrics] 1024² assessWorldMetrics: ${times.map((t) => t.toFixed(2)).join(", ")} -> best ${best.toFixed(2)}ms`,
    );
    expect(best).toBeLessThan(5);
  }, 60_000);
});
