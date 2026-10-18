import { describe, expect, it } from "vitest";
import { computeClimate } from "../src/climate";
import { createDefaultDocument, createPipeline } from "../src/index";
import { Biome } from "../src/types";

const SIZE = 256;

function meanOver(
  field: Float32Array,
  size: number,
  predicate: (x: number, y: number, index: number) => boolean,
): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      if (!predicate(x, y, i)) continue;
      sum += field[i];
      count += 1;
    }
  }
  return { sum, count };
}

describe("climate: orographic rain shadow (synthetic DEM)", () => {
  it("dries the lee side far below the windward plain", () => {
    const size = SIZE;
    const cells = size * size;
    const height = new Float32Array(cells);
    const ocean = new Uint8Array(cells);
    const lake = new Uint8Array(cells);
    // Windward ocean | flat plain at 0.1 | north-south ridge at 0.1..0.7 | lee plain.
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        if (x < 24 || x >= 232) {
          height[i] = 0.02;
          ocean[i] = 1;
          continue;
        }
        let h = 0.1;
        if (x >= 120 && x < 136) {
          const t = (x - 128) / 8;
          h = 0.1 + 0.6 * (1 - t * t);
        }
        height[i] = h;
      }
    }
    const result = computeClimate({
      size,
      height,
      ocean,
      lake,
      seaLevel: 0.05,
      windAngle: 0,
      windBands: false,
      moistureBias: 0,
      temperatureOffset: 0,
    });
    const band = (x0: number, x1: number) => {
      let sum = 0;
      let count = 0;
      for (let y = 40; y < size - 40; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += result.moisture[y * size + x];
          count += 1;
        }
      }
      return sum / count;
    };
    const windward = band(70, 115);
    const crest = band(118, 138);
    const lee = band(145, 215);
    expect(lee).toBeLessThan(windward - 0.1);
    expect(crest).toBeLessThan(windward - 0.1);
    expect(windward).toBeGreaterThan(0.2);
  });
});

describe("climate: pipeline-level rain shadow", () => {
  it("keeps the lee of a forced mountain ridge significantly drier", () => {
    const document = createDefaultDocument({
      seed: 12321,
      params: {
        gridSize: SIZE,
        windBands: false,
        windAngle: 0,
        seaLevel: 0.3,
        continentality: 0,
        ridgeStrength: 0.2,
        erosionIterations: 0,
        moistureBias: 0,
      },
    });
    const elevation: { x: number; y: number; radius: number; value: number; mode: "lock" }[] = [];
    for (let k = 0; k < 40; k += 1) {
      elevation.push({ x: 0.55, y: 0.15 + k * 0.018, radius: 0.025, value: 0.9, mode: "lock" });
    }
    const layers = createPipeline().generate({
      document: { ...document, overrides: { ...document.overrides, elevation } },
      size: SIZE,
    });
    const bandMoisture = (x0: number, x1: number): number => {
      const { sum, count } = meanOver(
        layers.moisture,
        SIZE,
        (x, y, i) =>
          x >= x0 &&
          x < x1 &&
          y >= 40 &&
          y < SIZE - 40 &&
          layers.ocean[i] === 0 &&
          layers.lake[i] === 0,
      );
      return count > 100 ? sum / count : NaN;
    };
    const windward = bandMoisture(60, 115);
    const lee = bandMoisture(150, 215);
    expect(Number.isFinite(windward)).toBe(true);
    expect(Number.isFinite(lee)).toBe(true);
    expect(lee).toBeLessThan(windward - 0.03);
  });
});

describe("climate: latitude and parameters", () => {
  const SIZE_MAIN = 192;
  const SEEDS = [5150, 99, 20261018, 777];
  interface BandStats {
    temp: number;
    moist: number;
    land: number;
  }
  const collect = (latMin: number, latMax: number): BandStats => {
    let tempSum = 0;
    let moistSum = 0;
    let land = 0;
    for (const seed of SEEDS) {
      const document = createDefaultDocument({ seed, params: { gridSize: SIZE_MAIN } });
      const layers = createPipeline().generate({ document, size: SIZE_MAIN });
      for (let y = 0; y < SIZE_MAIN; y += 1) {
        const lat = Math.abs((y + 0.5) / SIZE_MAIN - 0.5) * 2;
        if (lat < latMin || lat > latMax) continue;
        for (let x = 0; x < SIZE_MAIN; x += 1) {
          const i = y * SIZE_MAIN + x;
          if (layers.ocean[i]) continue;
          tempSum += layers.temperature[i];
          moistSum += layers.moisture[i];
          land += 1;
        }
      }
    }
    return { temp: tempSum / Math.max(1, land), moist: moistSum / Math.max(1, land), land };
  };

  it("is hot at the equator and cold at the poles", () => {
    const equator = collect(0, 0.12);
    const polar = collect(0.65, 0.85);
    expect(equator.land).toBeGreaterThan(500);
    expect(polar.land).toBeGreaterThan(100);
    expect(equator.temp).toBeGreaterThan(0.65);
    expect(polar.temp).toBeLessThan(0.4);
    expect(equator.temp - polar.temp).toBeGreaterThan(0.3);
  });

  it("places icy/tundra biomes at high latitudes and warm biomes at the equator", () => {
    const warm = new Set<number>([
      Biome.TropicalForest,
      Biome.Savanna,
      Biome.Shrubland,
      Biome.Desert,
      Biome.Wetland,
    ]);
    const cold = new Set<number>([Biome.Ice, Biome.Tundra, Biome.SnowPeak, Biome.Mountain]);
    let highLand = 0;
    let highCold = 0;
    let equatorialLand = 0;
    let equatorialWarm = 0;
    let iceCount = 0;
    for (const seed of SEEDS) {
      const document = createDefaultDocument({ seed, params: { gridSize: SIZE_MAIN } });
      const layers = createPipeline().generate({ document, size: SIZE_MAIN });
      for (let y = 0; y < SIZE_MAIN; y += 1) {
        const lat = Math.abs((y + 0.5) / SIZE_MAIN - 0.5) * 2;
        for (let x = 0; x < SIZE_MAIN; x += 1) {
          const i = y * SIZE_MAIN + x;
          if (layers.ocean[i] || layers.lake[i]) continue;
          if (layers.biome[i] === Biome.Ice) iceCount += 1;
          if (lat > 0.65) {
            highLand += 1;
            if (cold.has(layers.biome[i])) highCold += 1;
          }
          if (lat < 0.12) {
            equatorialLand += 1;
            if (warm.has(layers.biome[i])) equatorialWarm += 1;
          }
        }
      }
    }
    expect(highLand).toBeGreaterThan(100);
    expect(equatorialLand).toBeGreaterThan(500);
    expect(iceCount).toBeGreaterThan(100);
    expect(highCold / highLand).toBeGreaterThan(0.5);
    expect(equatorialWarm / equatorialLand).toBeGreaterThan(0.5);
  });

  it("applies temperatureOffset and moistureBias globally", () => {
    const base = createDefaultDocument({ seed: 99, params: { gridSize: 128 } });
    const warmer = { ...base, params: { ...base.params, temperatureOffset: 0.25 } };
    const drier = { ...base, params: { ...base.params, moistureBias: -0.4 } };
    const wetter = { ...base, params: { ...base.params, moistureBias: 0.4 } };
    const pipeline = createPipeline();
    const meanLand = (layers: ReturnType<typeof pipeline.generate>, field: Float32Array) => {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < field.length; i += 1) {
        if (layers.ocean[i]) continue;
        sum += field[i];
        count += 1;
      }
      return sum / count;
    };
    const baseLayers = pipeline.generate({ document: base, size: 128 });
    const warmLayers = pipeline.generate({ document: warmer, size: 128 });
    const dryLayers = pipeline.generate({ document: drier, size: 128 });
    const wetLayers = pipeline.generate({ document: wetter, size: 128 });
    expect(meanLand(warmLayers, warmLayers.temperature)).toBeGreaterThan(
      meanLand(baseLayers, baseLayers.temperature) + 0.1,
    );
    expect(meanLand(dryLayers, dryLayers.moisture)).toBeLessThan(
      meanLand(wetLayers, wetLayers.moisture) - 0.1,
    );
  });
});
