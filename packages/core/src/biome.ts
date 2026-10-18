/**
 * Biome stage: temperature × moisture × altitude × coast classification.
 * Writes every cell (water cells get Ocean/Lake). Brush biome stamps are applied
 * afterwards by the pipeline, on top of the classified layer.
 */
import { applyBiomeStamps } from "./overrides";
import { clamp, clamp01 } from "./rng";
import { Biome, type BiomeId, type BiomeStamp } from "./types";

export interface BiomeInput {
  size: number;
  height: Float32Array;
  ocean: Uint8Array;
  lake: Uint8Array;
  temperature: Float32Array;
  moisture: Float32Array;
  seaLevel: number;
  biomeStamps?: readonly BiomeStamp[];
}

export function classifyBiome(
  temperature: number,
  moisture: number,
  altitude: number,
): BiomeId {
  const t = clamp01(temperature);
  const m = clamp01(moisture);
  const a = clamp01(altitude);

  if (t < 0.115) return Biome.Ice;
  if (t < 0.24) {
    if (m > 0.42 && a < 0.7) return Biome.BorealForest;
    return Biome.Tundra;
  }
  // High mountains / snow line. Warmer latitudes need higher peaks to freeze.
  const snowLine = 0.54 + t * 0.26;
  if (a > snowLine) return Biome.SnowPeak;
  if (a > snowLine - 0.16) return Biome.Mountain;
  if (a < 0.035) return Biome.Beach;

  if (t < 0.4) {
    if (m > 0.42) return Biome.BorealForest;
    if (m > 0.24) return Biome.Grassland;
    return Biome.Tundra;
  }
  if (t < 0.64) {
    if (m > 0.66 && a < 0.08) return Biome.Wetland;
    if (m > 0.4) return Biome.TemperateForest;
    if (m > 0.24) return Biome.Grassland;
    if (m > 0.14) return Biome.Shrubland;
    return Biome.Desert;
  }
  // Tropical / subtropical.
  if (m > 0.7 && a < 0.12) return Biome.Wetland;
  if (m > 0.5) return Biome.TropicalForest;
  if (m > 0.28) return Biome.Savanna;
  if (m > 0.18) return Biome.Shrubland;
  return Biome.Desert;
}

export function computeBiomes(input: BiomeInput): Uint8Array {
  const size = input.size;
  const cells = size * size;
  const seaLevel = clamp(input.seaLevel, 0.02, 0.95);
  const seaSpan = Math.max(0.05, 1 - seaLevel);
  const biome = new Uint8Array(cells);
  biome.fill(255);
  const { height, ocean, lake, temperature, moisture } = input;

  for (let i = 0; i < cells; i += 1) {
    if (ocean[i]) {
      biome[i] = Biome.Ocean;
      continue;
    }
    if (lake[i]) {
      biome[i] = Biome.Lake;
      continue;
    }
    const altitude = clamp01((height[i] - seaLevel) / seaSpan);
    biome[i] = classifyBiome(temperature[i], moisture[i], altitude);
  }

  applyBiomeStamps(biome, size, input.biomeStamps, (index) => ocean[index] === 1 || lake[index] === 1);
  return biome;
}
