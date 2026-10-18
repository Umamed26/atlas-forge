import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline } from "../src/index";
import { Biome } from "../src/types";

const SIZE = 256;

describe("stage cache", () => {
  it("serves identical layers from cache without recomputing stages", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 31, params: { gridSize: SIZE } });
    const first = pipeline.generate({ document, size: SIZE });
    const second = pipeline.generate({ document, size: SIZE });
    expect(second.stats.terrainMs).toBe(0);
    expect(second.stats.hydrologyMs).toBe(0);
    expect(second.stats.climateMs).toBe(0);
    expect(second.stats.biomeMs).toBe(0);
    expect(second.stats.humanMs).toBe(0);
    expect(Array.from(second.height)).toEqual(Array.from(first.height));
    expect(Array.from(second.biome)).toEqual(Array.from(first.biome));
    expect(second.settlements).toEqual(first.settlements);
    pipeline.dispose();
  });

  it("only recomputes downstream stages when a downstream parameter changes", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 32, params: { gridSize: SIZE } });
    const first = pipeline.generate({ document, size: SIZE });

    // hydrology-only parameter: terrain + climate stay cached
    const hydroDoc = { ...document, params: { ...document.params, riverDensity: 0.92 } };
    const hydroLayers = pipeline.generate({ document: hydroDoc, size: SIZE });
    expect(hydroLayers.stats.terrainMs).toBe(0);
    expect(hydroLayers.stats.hydrologyMs).toBeGreaterThan(0);
    expect(hydroLayers.stats.climateMs).toBe(0);
    expect(Array.from(hydroLayers.height)).toEqual(Array.from(first.height));

    // climate-only parameter: terrain + hydrology stay cached
    const climateDoc = { ...hydroDoc, params: { ...hydroDoc.params, moistureBias: 0.42 } };
    const climateLayers = pipeline.generate({ document: climateDoc, size: SIZE });
    expect(climateLayers.stats.terrainMs).toBe(0);
    expect(climateLayers.stats.hydrologyMs).toBe(0);
    expect(climateLayers.stats.climateMs).toBeGreaterThan(0);
    expect(Array.from(climateLayers.height)).toEqual(Array.from(first.height));
    expect(Array.from(climateLayers.filled)).toEqual(Array.from(first.filled));

    // terrain parameter: everything below reruns
    const terrainDoc = { ...document, params: { ...document.params, continentScale: 1.7 } };
    const terrainLayers = pipeline.generate({ document: terrainDoc, size: SIZE });
    expect(terrainLayers.stats.terrainMs).toBeGreaterThan(0);
    expect(Array.from(terrainLayers.height)).not.toEqual(Array.from(first.height));
    pipeline.dispose();
  });

  it("invalidates only biome and downstream stages for biome stamps", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 33, params: { gridSize: SIZE } });
    pipeline.generate({ document, size: SIZE });
    let land = -1;
    const probe = pipeline.generate({ document, size: SIZE });
    for (let i = 0; i < probe.biome.length; i += 1) {
      if (probe.ocean[i] === 0 && probe.lake[i] === 0) {
        land = i;
        break;
      }
    }
    expect(land).toBeGreaterThanOrEqual(0);
    const x = (land % SIZE + 0.5) / SIZE;
    const y = (((land / SIZE) | 0) + 0.5) / SIZE;
    const stamped = {
      ...document,
      overrides: { ...document.overrides, biome: [{ x, y, radius: 0.03, biome: Biome.Desert }] },
    };
    const layers = pipeline.generate({ document: stamped, size: SIZE });
    expect(layers.stats.terrainMs).toBe(0);
    expect(layers.stats.hydrologyMs).toBe(0);
    expect(layers.stats.climateMs).toBe(0);
    expect(layers.stats.biomeMs).toBeGreaterThan(0);
    expect(layers.biome[land]).toBe(Biome.Desert);
    pipeline.dispose();
  });

  it("keeps the cache bounded to one entry per stage", () => {
    const pipeline = createPipeline();
    const docA = createDefaultDocument({ seed: 41, params: { gridSize: 128 } });
    const docB = createDefaultDocument({ seed: 42, params: { gridSize: 128 } });
    const a1 = pipeline.generate({ document: docA, size: 128 });
    pipeline.generate({ document: docB, size: 128 });
    const a2 = pipeline.generate({ document: docA, size: 128 });
    // A was evicted by B: it has to be recomputed instead of growing unbounded.
    expect(a2.stats.terrainMs).toBeGreaterThan(0);
    expect(Array.from(a2.height)).toEqual(Array.from(a1.height));
    pipeline.dispose();
  });

  it("recomputes after dispose()", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 43, params: { gridSize: 128 } });
    pipeline.generate({ document, size: 128 });
    pipeline.dispose();
    const again = pipeline.generate({ document, size: 128 });
    expect(again.stats.terrainMs).toBeGreaterThan(0);
  });

  it("keeps 1024² memory bounded across generations", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 61, params: { gridSize: 1024 } });
    const memory = (globalThis as { process?: { memoryUsage?: () => { arrayBuffers: number } } })
      .process?.memoryUsage;
    if (!memory) return; // browser-ish environment: nothing to measure here.
    const baseline = memory().arrayBuffers;
    let layers = pipeline.generate({ document, size: 1024 });
    layers = pipeline.generate({ document, size: 1024 }); // cache hit + fresh copies
    const afterRepeat = memory().arrayBuffers - baseline;
    // Cache (~25MB) + one copy of the returned layers (~25MB) + headroom.
    expect(afterRepeat).toBeLessThan(120 * 1024 * 1024);
    // Churn through two more worlds: memory must not grow without bound.
    pipeline.generate({ document: { ...document, seed: 62 }, size: 1024 });
    pipeline.generate({ document: { ...document, seed: 63 }, size: 1024 });
    const afterChurn = memory().arrayBuffers - baseline;
    expect(afterChurn).toBeLessThan(150 * 1024 * 1024);
    expect(layers.height.length).toBe(1024 * 1024);
    pipeline.dispose();
  }, 60_000);

  it("survives transferred (detached) output buffers like the Web Worker does", () => {
    const pipeline = createPipeline();
    const document = createDefaultDocument({ seed: 44, params: { gridSize: 128 } });
    const layers = pipeline.generate({ document, size: 128 });
    const buffers = [
      layers.height.buffer,
      layers.filled.buffer,
      layers.ocean.buffer,
      layers.lake.buffer,
      layers.river.buffer,
      layers.flow.buffer,
      layers.temperature.buffer,
      layers.moisture.buffer,
      layers.biome.buffer,
    ] as ArrayBuffer[];
    const biomeSnapshot = new Uint8Array(layers.biome);
    structuredClone(layers, { transfer: buffers });
    // Returned arrays are detached, but the stage caches must still be intact:
    // the next generation is a cache hit and produces usable layers.
    const again = pipeline.generate({ document, size: 128 });
    expect(again.height.length).toBe(128 * 128);
    expect(again.height.every((v) => Number.isFinite(v))).toBe(true);
    expect(again.stats.terrainMs).toBe(0);
    expect(Array.from(again.biome)).toEqual(Array.from(biomeSnapshot));
    pipeline.dispose();
  });
});
