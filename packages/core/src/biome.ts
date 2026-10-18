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
  /**
   * v0.5 Whittaker biome table + latitude-dependent snow line. Absent/false =
   * legacy classification (bit-for-bit identical for pre-v0.5 documents).
   */
  modern?: boolean;
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

/**
 * Whittaker-style temperature × precipitation lookup (v0.5), with special
 * cases for beaches, wetlands, mountains and a latitude-dependent snow line.
 * `latitude` is 0 at the equator and 1 at the poles.
 */
export function classifyWhittaker(
  temperature: number,
  moisture: number,
  altitude: number,
  latitude: number,
  /** Local height gradient magnitude (normalized height per cell). */
  slope = 0,
): BiomeId {
  const t = clamp01(temperature);
  const m = clamp01(moisture);
  const a = clamp01(altitude);
  const lat = clamp01(latitude);

  // Snow line drops toward the poles: high peaks near the equator (~0.82 of
  // the land altitude range) vs polar lowlands (~0.18).
  const snowLine = 0.18 + 0.64 * Math.pow(1 - lat, 1.25);
  if (t < 0.1) return Biome.Ice;
  if (a > snowLine) {
    // Snow only settles on the flatter high surfaces; steep faces stay bare
    // rock so mountain belts keep a peak/valley structure instead of one
    // uniform white band.
    return slope > 0.02 ? Biome.Mountain : Biome.SnowPeak;
  }
  if (a > snowLine - 0.17) return Biome.Mountain;
  if (a < 0.028) return Biome.Beach;

  if (t < 0.22) return m > 0.55 ? Biome.BorealForest : Biome.Tundra;
  if (t < 0.38) {
    if (m < 0.18) return Biome.Tundra;
    if (m < 0.4) return Biome.BorealForest;
    return m > 0.75 ? Biome.Wetland : Biome.BorealForest;
  }
  if (t < 0.55) {
    if (m < 0.14) return Biome.Desert;
    if (m < 0.28) return Biome.Shrubland;
    if (m < 0.45) return Biome.Grassland;
    if (m > 0.75 && a < 0.1) return Biome.Wetland;
    return Biome.TemperateForest;
  }
  if (t < 0.72) {
    if (m < 0.16) return Biome.Desert;
    if (m < 0.3) return Biome.Shrubland;
    if (m < 0.5) return Biome.Grassland;
    if (m < 0.68) return Biome.Savanna;
    if (m > 0.82 && a < 0.1) return Biome.Wetland;
    return Biome.TropicalForest;
  }
  if (m < 0.2) return Biome.Desert;
  if (m < 0.34) return Biome.Shrubland;
  if (m < 0.52) return Biome.Savanna;
  if (m > 0.86 && a < 0.1) return Biome.Wetland;
  return Biome.TropicalForest;
}

export function computeBiomes(input: BiomeInput): Uint8Array {
  const size = input.size;
  const cells = size * size;
  const seaLevel = clamp(input.seaLevel, 0.02, 0.95);
  const seaSpan = Math.max(0.05, 1 - seaLevel);
  const biome = new Uint8Array(cells);
  biome.fill(255);
  const { height, ocean, lake, temperature, moisture } = input;
  const modern = input.modern === true;
  const latRow = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    latRow[y] = Math.abs((y + 0.5) / size - 0.5) * 2;
  }

  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    const lat = latRow[y];
    for (let x = 0; x < size; x += 1) {
      const i = row + x;
      if (ocean[i]) {
        biome[i] = Biome.Ocean;
        continue;
      }
      if (lake[i]) {
        biome[i] = Biome.Lake;
        continue;
      }
      const altitude = clamp01((height[i] - seaLevel) / seaSpan);
      if (!modern) {
        biome[i] = classifyBiome(temperature[i], moisture[i], altitude);
        continue;
      }
      // Local slope (central difference, normalized height per cell).
      const left = x > 0 ? height[i - 1] : height[i];
      const right = x < size - 1 ? height[i + 1] : height[i];
      const up = y > 0 ? height[i - size] : height[i];
      const down = y < size - 1 ? height[i + size] : height[i];
      const slope = Math.sqrt(((right - left) * 0.5) ** 2 + ((down - up) * 0.5) ** 2);
      biome[i] = classifyWhittaker(temperature[i], moisture[i], altitude, lat, slope);
    }
  }

  applyBiomeStamps(biome, size, input.biomeStamps, (index) => ocean[index] === 1 || lake[index] === 1);
  return biome;
}
