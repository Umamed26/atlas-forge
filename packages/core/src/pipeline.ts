/**
 * Pipeline entry point.
 *
 * M0 STUB IMPLEMENTATION — core-dev replaces the internals with the real
 * terrain/hydrology/climate/biome/human stages. Signatures must stay stable.
 *
 * Contract:
 *  - deterministic for identical (document, size)
 *  - writes progress via onProgress (throttle inside)
 *  - returns typed arrays sized `size * size`
 */
import { DEFAULT_PARAMS } from "./defaults";
import {
  Biome,
  PIPELINE_STAGE_LABELS,
  type GenerateOptions,
  type Pipeline,
  type PipelineStage,
  type ProgressUpdate,
  type WorldLayers,
} from "./types";

const TWO_PI = Math.PI * 2;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const u = smoothstep(xf);
  const v = smoothstep(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, seed: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function emitProgress(
  onProgress: GenerateOptions["onProgress"],
  stage: PipelineStage,
  progress: number,
  startedAt: number,
): void {
  if (!onProgress) return;
  onProgress({
    stage,
    label: PIPELINE_STAGE_LABELS[stage],
    progress,
    elapsedMs: nowMs() - startedAt,
  });
}

/** M0 stub: believable-enough island field so the whole wiring is testable. */
export function createPipeline(): Pipeline {
  return {
    generate(options: GenerateOptions): WorldLayers {
      const startedAt = nowMs();
      const { document } = options;
      const params = { ...DEFAULT_PARAMS, ...document.params };
      const size = options.size ?? params.gridSize;
      const cells = size * size;

      emitProgress(options.onProgress, "terrain", 0.05, startedAt);
      const height = new Float32Array(cells);
      const ridgeMask = new Float32Array(cells);
      const terrainStarted = nowMs();
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const nx = x / size;
          const ny = y / size;
          const wx = nx + (fbm(nx * 2.3 + 11.7, ny * 2.3 + 3.1, document.seed + 91, 3) - 0.5) * params.warpStrength * 0.6;
          const wy = ny + (fbm(nx * 2.3 - 5.9, ny * 2.3 + 8.3, document.seed + 37, 3) - 0.5) * params.warpStrength * 0.6;
          const base = fbm(wx * 2.4 * params.continentScale, wy * 2.4 * params.continentScale, document.seed, 6);
          const ridge = 1 - Math.abs(2 * fbm(wx * 4.6 * params.ridgeScale, wy * 4.6 * params.ridgeScale, document.seed + 7, 4) - 1);
          const dx = nx * 2 - 1;
          const dy = ny * 2 - 1;
          const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
          const falloff = smoothstep(Math.min(1, Math.max(0, (dist - 0.42) / 0.68))) * params.continentality;
          const h = Math.min(1, Math.max(0, base * 0.86 + 0.14 - falloff * 0.62));
          height[y * size + x] = h;
          ridgeMask[y * size + x] = ridge;
        }
      }
      const terrainMs = nowMs() - terrainStarted;

      emitProgress(options.onProgress, "hydrology", 0.35, startedAt);
      const hydrologyStarted = nowMs();
      const filled = new Float32Array(height);
      const ocean = new Uint8Array(cells);
      const lake = new Uint8Array(cells);
      const river = new Uint8Array(cells);
      const flow = new Float32Array(cells);
      let landCells = 0;
      for (let i = 0; i < cells; i += 1) {
        if (height[i] < params.seaLevel) {
          ocean[i] = 1;
          flow[i] = 0;
        } else {
          landCells += 1;
          const x = i % size;
          const y = (i / size) | 0;
          // Stub rivers: a few deterministic, mostly believable drainage threads.
          const thread = Math.abs(fbm(x / size * 9.1, y / size * 9.1, document.seed + 501, 3) - 0.5);
          const drainage = smoothstep(Math.min(1, Math.max(0, 1 - thread * 26)));
          flow[i] = drainage * (height[i] - params.seaLevel) * 900;
          if (drainage * (0.35 + params.riverDensity) > 0.62 && height[i] > params.seaLevel + 0.01) {
            river[i] = 1;
          }
          if (height[i] < params.seaLevel + 0.008 && flow[i] < 12) {
            lake[i] = 1;
            ocean[i] = 0;
            river[i] = 0;
          }
        }
      }
      // Stub temperature: latitude + altitude.
      const temperature = new Float32Array(cells);
      const moisture = new Float32Array(cells);
      const biome = new Uint8Array(cells);
      const climateStarted = nowMs();
      for (let y = 0; y < size; y += 1) {
        const lat = Math.abs(y / size - 0.5) * 2; // 0 equator .. 1 pole
        for (let x = 0; x < size; x += 1) {
          const i = y * size + x;
          const t = Math.min(1, Math.max(0, 1 - lat * 0.92 - Math.max(0, height[i] - params.seaLevel) * 0.9 + params.temperatureOffset));
          temperature[i] = t;
          const m = Math.min(1, Math.max(0, fbm(x / size * 3.7 + 40, y / size * 3.7 + 17, document.seed + 301, 4) * 0.9 + 0.08 + params.moistureBias - lat * 0.12));
          moisture[i] = m;
          if (ocean[i]) biome[i] = Biome.Ocean;
          else if (lake[i]) biome[i] = Biome.Lake;
          else if (t > 0.82 && m > 0.55) biome[i] = Biome.TropicalForest;
          else if (t > 0.78) biome[i] = m > 0.38 ? Biome.Savanna : Biome.Desert;
          else if (t > 0.55) biome[i] = m > 0.55 ? Biome.TemperateForest : m > 0.3 ? Biome.Grassland : Biome.Shrubland;
          else if (t > 0.32) biome[i] = m > 0.5 ? Biome.BorealForest : Biome.Grassland;
          else if (t > 0.15) biome[i] = Biome.Tundra;
          else biome[i] = Biome.Ice;
          if (!ocean[i] && !lake[i] && height[i] > params.seaLevel + 0.42) biome[i] = Biome.SnowPeak;
          else if (!ocean[i] && !lake[i] && height[i] > params.seaLevel + 0.3) biome[i] = Biome.Mountain;
        }
      }
      const climateMs = nowMs() - climateStarted;
      emitProgress(options.onProgress, "climate", 0.7, startedAt);
      emitProgress(options.onProgress, "biome", 0.85, startedAt);
      emitProgress(options.onProgress, "human", 0.95, startedAt);

      const hydrologyMs = nowMs() - hydrologyStarted - climateMs;
      const totalMs = nowMs() - startedAt;
      const stats = {
        terrainMs,
        hydrologyMs: Math.max(0, hydrologyMs),
        climateMs,
        biomeMs: 0,
        humanMs: 0,
        totalMs,
        landFraction: landCells / cells,
      };
      emitProgress(options.onProgress, "done", 1, startedAt);

      return {
        size,
        seed: document.seed,
        height,
        filled,
        ocean,
        lake,
        river,
        flow,
        temperature,
        moisture,
        biome,
        settlements: [],
        autoLabels: [],
        stats,
      };
    },
    dispose(): void {
      // no cached state yet
    },
  };
}

/** Convenience for one-shot generation. */
export function generateWorld(options: GenerateOptions): WorldLayers {
  return createPipeline().generate(options);
}

export { TWO_PI };
