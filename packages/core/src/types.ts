/**
 * Atlas Forge — shared data contracts.
 *
 * This file is the single source of truth for the persisted world document,
 * the derived render layers, and the pipeline API. Public contract changes
 * must be agreed with the Lead to avoid drift across core/render/web/server.
 */

// ── Biomes ────────────────────────────────────────────────────────────────
export const Biome = {
  Ocean: 0,
  Lake: 1,
  Ice: 2,
  Tundra: 3,
  BorealForest: 4,
  TemperateForest: 5,
  Grassland: 6,
  Shrubland: 7,
  Savanna: 8,
  Desert: 9,
  TropicalForest: 10,
  Wetland: 11,
  Beach: 12,
  Mountain: 13,
  SnowPeak: 14,
} as const;
export type BiomeId = (typeof Biome)[keyof typeof Biome];

export const BIOME_NAMES: Record<BiomeId, string> = {
  [Biome.Ocean]: "海洋",
  [Biome.Lake]: "湖泊",
  [Biome.Ice]: "冰原",
  [Biome.Tundra]: "苔原",
  [Biome.BorealForest]: "针叶林",
  [Biome.TemperateForest]: "温带森林",
  [Biome.Grassland]: "草原",
  [Biome.Shrubland]: "灌木地",
  [Biome.Savanna]: "稀树草原",
  [Biome.Desert]: "沙漠",
  [Biome.TropicalForest]: "热带雨林",
  [Biome.Wetland]: "湿地",
  [Biome.Beach]: "海滩",
  [Biome.Mountain]: "山地",
  [Biome.SnowPeak]: "雪峰",
};

// ── Parameters ────────────────────────────────────────────────────────────
export interface WorldParams {
  /** Preview simulation grid edge length (power of two). */
  gridSize: number;
  /** 0..1 fraction of raw height submerged by the sea. */
  seaLevel: number;
  /** Relative continent size: <1 fewer larger landmasses, >2 more/smaller. */
  continentScale: number;
  /** 0..1 strength of radial falloff toward map edges (ocean margins). */
  continentality: number;
  /** 0..1 domain-warping strength for organic coastlines. */
  warpStrength: number;
  /** 0..1 strength of the ridged-multifractal mountain mask. */
  ridgeStrength: number;
  /** Frequency multiplier for mountain ridges. */
  ridgeScale: number;
  /** Number of stream-power erosion iterations (0..200). */
  erosionIterations: number;
  /** 0..1 river density (maps to a flow-accumulation threshold). */
  riverDensity: number;
  /** Prevailing wind direction, degrees (0 = from west / eastward flow). */
  windAngle: number;
  /** Use latitude-based wind bands (trades/westerlies) instead of one global wind. */
  windBands: boolean;
  /** -0.5..0.5 global moisture bias (negative = drier). */
  moistureBias: number;
  /** -0.35..0.35 global temperature shift. */
  temperatureOffset: number;
}

export interface RenderStyle {
  preset: "parchment-classic" | "aged-ink";
  title: string;
  showLabels: boolean;
  showRivers: boolean;
  showGraticule: boolean;
  showBorder: boolean;
  showCompass: boolean;
  showLegend: boolean;
  /** 0..1 */
  labelDensity: number;
  /** 0..1 paper grain / stains */
  paperTexture: number;
  /** 0..1 hillshade opacity */
  hillshadeStrength: number;
  /** 0..1 coastline hatching */
  coastHatching: number;
}

// ── Overrides: all coordinates are normalized world space [0,1] ───────────
export interface Stamp {
  x: number;
  y: number;
  /** Normalized radius; 0.01 ≈ 1% of the shorter map edge. */
  radius: number;
}

export type ElevationMode = "lock" | "raise" | "lower";

export interface ElevationStamp extends Stamp {
  /** lock: absolute 0..1 height. raise/lower: delta in -0.4..0.4. */
  value: number;
  mode: ElevationMode;
}

export interface BiomeStamp extends Stamp {
  biome: BiomeId;
}

export interface RiverForcePath {
  id: string;
  points: [number, number][];
  /** Normalized river width. */
  width: number;
}

export interface WorldOverrides {
  elevation: ElevationStamp[];
  riverForce: RiverForcePath[];
  biome: BiomeStamp[];
  /** Generated label/settlement ids the user deleted. */
  hiddenIds: string[];
}

// ── Content entities ──────────────────────────────────────────────────────
export type SettlementKind = "city" | "town" | "port" | "fortress" | "ruin" | "custom";
export type LabelKind = "region" | "water" | "mountain" | "custom";

export interface Settlement {
  id: string;
  name: string;
  kind: SettlementKind;
  /** Normalized world coordinates. */
  x: number;
  y: number;
  population?: number;
  /** User-edited / pinned entries win over generated ones. */
  pinned?: boolean;
}

export interface MapLabel {
  id: string;
  text: string;
  kind: LabelKind;
  x: number;
  y: number;
  rotation?: number;
  size?: number;
  pinned?: boolean;
}

// ── Persisted document ────────────────────────────────────────────────────
export interface WorldDocument {
  version: 1;
  id: string;
  name: string;
  seed: number;
  params: WorldParams;
  style: RenderStyle;
  overrides: WorldOverrides;
  /** User-modified / pinned settlements only; generated ones live in layers. */
  settlements: Settlement[];
  /** User-added / edited labels only. */
  labels: MapLabel[];
  createdAt: string;
  updatedAt: string;
}

// ── Derived layers (never persisted) ──────────────────────────────────────
export interface PipelineStats {
  terrainMs: number;
  hydrologyMs: number;
  climateMs: number;
  biomeMs: number;
  humanMs: number;
  totalMs: number;
  landFraction: number;
}

export interface WorldLayers {
  /** Simulation grid edge length. */
  size: number;
  seed: number;
  /** Raw post-erosion height 0..1. */
  height: Float32Array;
  /** Depression-filled height 0..1; water always flows downhill on this. */
  filled: Float32Array;
  /** 1 = ocean. */
  ocean: Uint8Array;
  /** 1 = lake. */
  lake: Uint8Array;
  /** 1 = river cell. */
  river: Uint8Array;
  /** D8 flow accumulation in upstream cells. */
  flow: Float32Array;
  /** Normalized temperature 0 (cold) .. 1 (hot). */
  temperature: Float32Array;
  /** Normalized moisture 0 (arid) .. 1 (wet). */
  moisture: Float32Array;
  biome: Uint8Array;
  settlements: Settlement[];
  autoLabels: MapLabel[];
  stats: PipelineStats;
}

// ── Pipeline API ──────────────────────────────────────────────────────────
export type PipelineStage = "terrain" | "hydrology" | "climate" | "biome" | "human" | "done";

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  terrain: "地形",
  hydrology: "水文",
  climate: "气候",
  biome: "群系",
  human: "人文",
  done: "完成",
};

export interface ProgressUpdate {
  stage: PipelineStage;
  label: string;
  /** 0..1 overall progress. */
  progress: number;
  elapsedMs: number;
}

export interface GenerateOptions {
  document: WorldDocument;
  /** Override simulation grid size; defaults to document.params.gridSize. */
  size?: number;
  onProgress?: (update: ProgressUpdate) => void;
}

export interface Pipeline {
  /** Deterministic: same document + size => identical layers. */
  generate(options: GenerateOptions): WorldLayers;
  /** Drop cached upstream stages (e.g. after importing a different document). */
  dispose(): void;
}

// ── Export ────────────────────────────────────────────────────────────────
export interface RenderJob {
  document: WorldDocument;
  /** Output image edge length in pixels. */
  size: number;
}

export const MAX_RENDER_SIZE = 8192;
export const MIN_RENDER_SIZE = 512;
