import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline, generateWorld } from "../src/index";
import { Biome } from "../src/types";
import type { WorldDocument } from "../src/types";

function bytesOf(array: Float32Array | Uint8Array): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function expectSameLayers(a: ReturnType<typeof generateWorld>, b: ReturnType<typeof generateWorld>): void {
  const floatLayers = ["height", "filled", "flow", "temperature", "moisture"] as const;
  for (const layer of floatLayers) {
    expect(bytesOf(a[layer])).toEqual(bytesOf(b[layer]));
  }
  const intLayers = ["ocean", "lake", "river", "biome"] as const;
  for (const layer of intLayers) {
    expect(bytesOf(a[layer])).toEqual(bytesOf(b[layer]));
  }
  expect(a.settlements).toEqual(b.settlements);
  expect(a.autoLabels).toEqual(b.autoLabels);
}

describe("pipeline contract", () => {
  it("is deterministic for identical document + size (same pipeline instance)", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 1234, params: { gridSize: 96 } });
    const a = pipeline.generate({ document, size: 96 });
    const b = pipeline.generate({ document, size: 96 });
    expectSameLayers(a, b);
    pipeline.dispose();
  });

  it("is deterministic across pipeline instances", () => {
    const document = createDefaultDocument({ seed: 987654, params: { gridSize: 80 } });
    expectSameLayers(generateWorld({ document, size: 80 }), generateWorld({ document, size: 80 }));
  });

  it("returns typed arrays of exactly size*size with every element written", () => {
    const document = createDefaultDocument({ seed: 7 });
    const size = 192;
    const layers = generateWorld({ document, size });
    const count = size * size;
    expect(layers.size).toBe(size);
    expect(layers.seed).toBe(document.seed);

    // Collect violations and assert once: per-element expect() calls make this
    // test (and the whole suite) needlessly slow on shared CI machines.
    const violations: string[] = [];
    const floatLayers = [layers.height, layers.filled, layers.flow, layers.temperature, layers.moisture];
    for (const layer of floatLayers) {
      expect(layer).toBeInstanceOf(Float32Array);
      expect(layer.length).toBe(count);
      for (let i = 0; i < count; i += 1) {
        if (!Number.isFinite(layer[i])) {
          violations.push(`non-finite float at ${i}`);
          break;
        }
      }
    }
    const intLayers = [
      ["ocean", layers.ocean],
      ["lake", layers.lake],
      ["river", layers.river],
      ["biome", layers.biome],
    ] as const;
    for (const [name, layer] of intLayers) {
      expect(layer).toBeInstanceOf(Uint8Array);
      expect(layer.length).toBe(count);
      for (let i = 0; i < count; i += 1) {
        const value = layer[i];
        if (name === "biome") {
          if (value < Biome.Ocean || value > Biome.SnowPeak) {
            violations.push(`biome ${value} out of range at ${i}`);
            break;
          }
        } else if (value !== 0 && value !== 1) {
          violations.push(`${name} must be 0/1, got ${value} at ${i}`);
          break;
        }
      }
    }
    // Ranges advertised by the contract.
    for (let i = 0; i < count; i += 1) {
      const h = layers.height[i];
      const t = layers.temperature[i];
      const m = layers.moisture[i];
      if (h < 0 || h > 1 || t < 0 || t > 1 || m < 0 || m > 1 || layers.flow[i] < 0) {
        violations.push(
          `out-of-range value at ${i}: h=${h} t=${t} m=${m} flow=${layers.flow[i]}`,
        );
        break;
      }
    }
    expect(violations).toEqual([]);
    expect(layers.stats.landFraction).toBeGreaterThan(0.05);
    expect(layers.stats.landFraction).toBeLessThan(0.95);
  });

  it("fills depression-filled surface at least to the raw height", () => {
    const document = createDefaultDocument({ seed: 55, params: { gridSize: 96 } });
    const layers = generateWorld({ document, size: 96 });
    for (let i = 0; i < layers.filled.length; i += 1) {
      expect(layers.filled[i]).toBeGreaterThanOrEqual(layers.height[i] - 1e-6);
    }
  });

  it("produces different worlds for different seeds", () => {
    const size = 96;
    const a = generateWorld({ document: createDefaultDocument({ seed: 1 }), size });
    const b = generateWorld({ document: createDefaultDocument({ seed: 2 }), size });
    expect(bytesOf(a.height)).not.toEqual(bytesOf(b.height));
    expect(a.settlements).not.toEqual(b.settlements);
  });

  it("restores byte-identical layers after a seed round-trip, overrides included", () => {
    const pipeline = createPipeline();
    const document: WorldDocument = createDefaultDocument({
      seed: 4242,
      params: { gridSize: 128 },
      overrides: {
        elevation: [{ x: 0.45, y: 0.5, radius: 0.08, value: 0.85, mode: "lock" }],
        riverForce: [{ id: "forced-1", width: 0.014, points: [[0.4, 0.42], [0.5, 0.55], [0.62, 0.68]] }],
        biome: [{ x: 0.3, y: 0.3, radius: 0.07, biome: Biome.Desert }],
        hiddenIds: ["does-not-exist"],
      },
    });
    const first = pipeline.generate({ document, size: 128 });
    const otherSeed = pipeline.generate({ document: { ...document, seed: 999 }, size: 128 });
    const again = pipeline.generate({ document, size: 128 });
    expectSameLayers(first, again);
    expect(bytesOf(first.height)).not.toEqual(bytesOf(otherSeed.height));
  });

  it("reports real stage timings that add up to the total", () => {
    const document = createDefaultDocument({ seed: 77, params: { gridSize: 128 } });
    const layers = generateWorld({ document, size: 128 });
    const stats = layers.stats;
    const stages =
      stats.terrainMs + stats.hydrologyMs + stats.climateMs + stats.biomeMs + stats.humanMs;
    for (const value of [stats.terrainMs, stats.hydrologyMs, stats.climateMs, stats.biomeMs, stats.humanMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(stats.totalMs).toBeGreaterThanOrEqual(stages - 5);
    expect(stats.totalMs).toBeLessThan(60_000);
    expect(stats.landFraction).toBeGreaterThan(0);
    expect(stats.landFraction).toBeLessThan(1);
  });

  it("respects an explicit size override independent of params.gridSize", () => {
    const document = createDefaultDocument({ seed: 3, params: { gridSize: 1024 } });
    const layers = generateWorld({ document, size: 64 });
    expect(layers.size).toBe(64);
    expect(layers.height.length).toBe(64 * 64);
  });

  it("emits progress for every pipeline stage and ends at 100%", () => {
    const document = createDefaultDocument({ seed: 11, params: { gridSize: 64 } });
    const stages: string[] = [];
    let lastProgress = 0;
    let monotonic = true;
    generateWorld({
      document,
      size: 64,
      onProgress: (update) => {
        stages.push(update.stage);
        if (update.progress < lastProgress - 1e-9) monotonic = false;
        lastProgress = update.progress;
        expect(update.label.length).toBeGreaterThan(0);
        expect(update.elapsedMs).toBeGreaterThanOrEqual(0);
      },
    });
    expect(stages[0]).toBe("terrain");
    expect(stages[stages.length - 1]).toBe("done");
    expect(monotonic).toBe(true);
    expect(lastProgress).toBe(1);
    for (const stage of ["terrain", "hydrology", "climate", "biome", "human"]) {
      expect(stages).toContain(stage);
    }
  });
});
