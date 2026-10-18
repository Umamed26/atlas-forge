/**
 * Pipeline entry point.
 *
 * Layers, in dependency order (each is a cache boundary):
 *   terrain -> hydrology -> climate -> biome -> human
 *
 * Contract:
 *  - purely deterministic for identical (document, size)
 *  - progress is emitted through onProgress
 *  - typed arrays are always `size * size`, fully written
 *  - stage caches are bounded (single entry each, disabled for giant grids) and
 *    hold the pristine simulation arrays; cached stage arrays are copied into
 *    the returned WorldLayers so a caller may transfer (detach) the result
 *    buffers without corrupting the cache.
 */
import { DEFAULT_PARAMS } from "./defaults";
import { SingleStageCache } from "./cache";
import { computeBiomes } from "./biome";
import { computeClimate } from "./climate";
import { generateHuman } from "./human";
import { computeHydrology } from "./hydrology";
import {
  biomeStampKey,
  elevationStampKey,
  riverForceKey,
  userContentKey,
} from "./overrides";
import { generateTerrain } from "./terrain";
import {
  PIPELINE_STAGE_LABELS,
  type GenerateOptions,
  type Pipeline,
  type PipelineStage,
  type PipelineStats,
  type ProgressUpdate,
  type WorldDocument,
  type WorldLayers,
  type WorldOverrides,
  type WorldParams,
} from "./types";

const TWO_PI = Math.PI * 2;

/** Hard caps that keep 1024² comfortable and 8192² server exports possible. */
const MIN_SIZE = 16;
const MAX_SIZE = 8192;
/**
 * Caches are only kept for grids <= this many cells. 1024² = 1.05M cells:
 * cached simulation arrays are ≈24MB, so the whole pipeline stays well under
 * the 80MB budget. 8192² (67M cells) is never cached.
 */
const MAX_CACHED_CELLS = 4_194_304;

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
  const update: ProgressUpdate = {
    stage,
    label: PIPELINE_STAGE_LABELS[stage],
    progress,
    elapsedMs: nowMs() - startedAt,
  };
  onProgress(update);
}

function resolveSize(requested: number | undefined, params: WorldParams): number {
  const candidate = requested ?? params.gridSize;
  let size = Math.round(Number(candidate));
  if (!Number.isFinite(size)) size = 1024;
  if (size < MIN_SIZE) size = MIN_SIZE;
  if (size > MAX_SIZE) size = MAX_SIZE;
  return size;
}

/**
 * Parameter groups mirror the stage dependency graph so a slider edit only
 * invalidates the stages that actually consume it.
 */
function terrainSignature(params: WorldParams): string {
  return [
    params.continentScale,
    params.continentality,
    params.warpStrength,
    params.ridgeStrength,
    params.ridgeScale,
    params.erosionIterations,
  ].join(",");
}

function hydrologySignature(params: WorldParams): string {
  return [params.seaLevel, params.riverDensity].join(",");
}

function climateSignature(params: WorldParams): string {
  return [
    params.seaLevel,
    params.windAngle,
    params.windBands ? 1 : 0,
    params.moistureBias,
    params.temperatureOffset,
  ].join(",");
}

interface TerrainCacheValue {
  height: Float32Array;
  channel: Uint8Array;
}

interface HydrologyCacheValue {
  filled: Float32Array;
  ocean: Uint8Array;
  lake: Uint8Array;
  river: Uint8Array;
  flow: Float32Array;
  oceanCount: number;
  landCells: number;
  riverThreshold: number;
  lakeCount: number;
}

interface ClimateCacheValue {
  temperature: Float32Array;
  moisture: Float32Array;
}

interface BiomeCacheValue {
  biome: Uint8Array;
}

interface HumanCacheValue {
  settlements: WorldLayers["settlements"];
  autoLabels: WorldLayers["autoLabels"];
}

function arraysAlive(cells: number, arrays: (Float32Array | Uint8Array)[]): boolean {
  for (const array of arrays) {
    if (!array || array.length !== cells) return false;
  }
  return true;
}

function normalizeOverrides(overrides: WorldOverrides | undefined): WorldOverrides {
  return {
    elevation: overrides?.elevation ?? [],
    riverForce: overrides?.riverForce ?? [],
    biome: overrides?.biome ?? [],
    hiddenIds: overrides?.hiddenIds ?? [],
  };
}

/** Create an independent, disposable pipeline with its own bounded caches. */
export function createPipeline(): Pipeline {
  const terrainCache = new SingleStageCache<TerrainCacheValue>();
  const hydrologyCache = new SingleStageCache<HydrologyCacheValue>();
  const climateCache = new SingleStageCache<ClimateCacheValue>();
  const biomeCache = new SingleStageCache<BiomeCacheValue>();
  const humanCache = new SingleStageCache<HumanCacheValue>();

  return {
    generate(options: GenerateOptions): WorldLayers {
      const startedAt = nowMs();
      if (!options || !options.document) {
        throw new Error("generate: options.document is required");
      }
      const document: WorldDocument = options.document;
      const params: WorldParams = { ...DEFAULT_PARAMS, ...document.params };
      const size = resolveSize(options.size, params);
      const cells = size * size;
      const caching = cells <= MAX_CACHED_CELLS;
      const overrides = normalizeOverrides(document.overrides);

      const elevationKey = elevationStampKey(overrides.elevation);
      const riverKey = riverForceKey(overrides.riverForce);
      const biomeKey = biomeStampKey(overrides.biome);
      const terrainKey = `t|${size}|${document.seed}|${terrainSignature(params)}|${elevationKey}|${riverKey}`;
      const hydrologyKey = `${terrainKey}§h|${hydrologySignature(params)}`;
      const climateKey = `${terrainKey}§c|${climateSignature(params)}`;
      const biomeFingerprint = `${climateKey}§b|${biomeKey}`;
      const humanFingerprint = `${biomeFingerprint}§u|${hydrologyKey}|${params.namingLanguage ?? "auto"}|${userContentKey(
        document.settlements,
        document.labels,
        overrides,
      )}`;

      // ── terrain ────────────────────────────────────────────────────────
      emitProgress(options.onProgress, "terrain", 0.02, startedAt);
      let terrain = caching ? terrainCache.get(terrainKey) : null;
      let terrainHit = terrain !== null;
      if (terrain && !arraysAlive(cells, [terrain.height, terrain.channel])) {
        terrainCache.clear();
        terrain = null;
        terrainHit = false;
      }
      let terrainMs = 0;
      if (!terrain) {
        terrainHit = false;
        if (caching) terrainCache.clear();
        const t0 = nowMs();
        terrain = generateTerrain(size, document.seed, params, overrides);
        terrainMs = nowMs() - t0;
        if (caching) terrainCache.set(terrainKey, terrain);
      }
      const height = terrain.height;
      const channel = terrain.channel;

      // ── hydrology ──────────────────────────────────────────────────────
      emitProgress(options.onProgress, "hydrology", 0.34, startedAt);
      let hydrology = caching ? hydrologyCache.get(hydrologyKey) : null;
      let hydrologyHit = hydrology !== null;
      if (
        hydrology &&
        !arraysAlive(cells, [
          hydrology.filled,
          hydrology.ocean,
          hydrology.lake,
          hydrology.river,
          hydrology.flow,
        ])
      ) {
        hydrologyCache.clear();
        hydrology = null;
        hydrologyHit = false;
      }
      let hydrologyMs = 0;
      if (!hydrology) {
        hydrologyHit = false;
        if (caching) hydrologyCache.clear();
        const t0 = nowMs();
        const result = computeHydrology({
          size,
          height,
          channel,
          seaLevel: params.seaLevel,
          riverDensity: params.riverDensity,
        });
        hydrologyMs = nowMs() - t0;
        hydrology = {
          filled: result.filled,
          ocean: result.ocean,
          lake: result.lake,
          river: result.river,
          flow: result.flow,
          oceanCount: result.oceanCount,
          landCells: result.landCells,
          riverThreshold: result.riverThreshold,
          lakeCount: result.lakeCount,
        };
        if (caching) hydrologyCache.set(hydrologyKey, hydrology);
      }

      // ── climate ────────────────────────────────────────────────────────
      emitProgress(options.onProgress, "climate", 0.62, startedAt);
      let climate = caching ? climateCache.get(climateKey) : null;
      let climateHit = climate !== null;
      if (climate && !arraysAlive(cells, [climate.temperature, climate.moisture])) {
        climateCache.clear();
        climate = null;
        climateHit = false;
      }
      let climateMs = 0;
      if (!climate) {
        climateHit = false;
        if (caching) climateCache.clear();
        const t0 = nowMs();
        climate = computeClimate({
          size,
          height,
          ocean: hydrology.ocean,
          lake: hydrology.lake,
          seaLevel: params.seaLevel,
          windAngle: params.windAngle,
          windBands: params.windBands,
          moistureBias: params.moistureBias,
          temperatureOffset: params.temperatureOffset,
        });
        climateMs = nowMs() - t0;
        if (caching) climateCache.set(climateKey, climate);
      }

      // ── biome ──────────────────────────────────────────────────────────
      emitProgress(options.onProgress, "biome", 0.8, startedAt);
      let biomeResult = caching ? biomeCache.get(biomeFingerprint) : null;
      let biomeHit = biomeResult !== null;
      if (biomeResult && !arraysAlive(cells, [biomeResult.biome])) {
        biomeCache.clear();
        biomeResult = null;
        biomeHit = false;
      }
      let biomeMs = 0;
      if (!biomeResult) {
        biomeHit = false;
        if (caching) biomeCache.clear();
        const t0 = nowMs();
        biomeResult = {
          biome: computeBiomes({
            size,
            height,
            ocean: hydrology.ocean,
            lake: hydrology.lake,
            temperature: climate.temperature,
            moisture: climate.moisture,
            seaLevel: params.seaLevel,
            biomeStamps: overrides.biome,
          }),
        };
        biomeMs = nowMs() - t0;
        if (caching) biomeCache.set(biomeFingerprint, biomeResult);
      }

      // ── human ──────────────────────────────────────────────────────────
      emitProgress(options.onProgress, "human", 0.9, startedAt);
      let human = caching ? humanCache.get(humanFingerprint) : null;
      let humanHit = human !== null;
      let humanMs = 0;
      if (!human) {
        humanHit = false;
        if (caching) humanCache.clear();
        const t0 = nowMs();
        human = generateHuman({
          size,
          seed: document.seed,
          params,
          height,
          filled: hydrology.filled,
          ocean: hydrology.ocean,
          lake: hydrology.lake,
          river: hydrology.river,
          flow: hydrology.flow,
          temperature: climate.temperature,
          moisture: climate.moisture,
          biome: biomeResult.biome,
          riverThreshold: hydrology.riverThreshold,
          overrides,
          settlements: document.settlements,
          labels: document.labels,
        });
        humanMs = nowMs() - t0;
        if (caching) humanCache.set(humanFingerprint, human);
      }

      // ── assemble output ────────────────────────────────────────────────
      // The returned arrays are always fresh copies: callers (notably the Web
      // Worker) transfer/detach output buffers, which must never damage the
      // pristine stage caches, and callers must never be able to mutate cached
      // simulation state. Copying 1024² layers costs a few milliseconds.
      const outHeight = new Float32Array(height);
      const outFilled = new Float32Array(hydrology.filled);
      const outOcean = new Uint8Array(hydrology.ocean);
      const outLake = new Uint8Array(hydrology.lake);
      const outRiver = new Uint8Array(hydrology.river);
      const outFlow = new Float32Array(hydrology.flow);
      const outTemperature = new Float32Array(climate.temperature);
      const outMoisture = new Float32Array(climate.moisture);
      const outBiome = new Uint8Array(biomeResult.biome);
      const settlements = human.settlements.map((settlement) => ({ ...settlement }));
      const autoLabels = human.autoLabels.map((label) => ({ ...label }));

      const totalMs = nowMs() - startedAt;
      const stats: PipelineStats = {
        terrainMs,
        hydrologyMs,
        climateMs,
        biomeMs,
        humanMs,
        totalMs,
        landFraction: hydrology.landCells / cells,
      };

      emitProgress(options.onProgress, "done", 1, startedAt);

      return {
        size,
        seed: document.seed,
        height: outHeight,
        filled: outFilled,
        ocean: outOcean,
        lake: outLake,
        river: outRiver,
        flow: outFlow,
        temperature: outTemperature,
        moisture: outMoisture,
        biome: outBiome,
        settlements,
        autoLabels,
        stats,
      };
    },

    dispose(): void {
      terrainCache.clear();
      hydrologyCache.clear();
      climateCache.clear();
      biomeCache.clear();
      humanCache.clear();
    },
  };
}

/** Convenience for one-shot generation. */
export function generateWorld(options: GenerateOptions): WorldLayers {
  return createPipeline().generate(options);
}

export { TWO_PI };
