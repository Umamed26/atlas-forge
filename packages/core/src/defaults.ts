import type { RenderStyle, WorldDocument, WorldParams } from "./types";

export const DEFAULT_PARAMS: WorldParams = {
  gridSize: 1024,
  seaLevel: 0.42,
  continentScale: 1.0,
  continentality: 0.62,
  warpStrength: 0.35,
  ridgeStrength: 0.55,
  ridgeScale: 2.1,
  erosionIterations: 60,
  riverDensity: 0.5,
  windAngle: 0,
  windBands: true,
  moistureBias: 0,
  temperatureOffset: 0,
  namingLanguage: "auto",
};

export const DEFAULT_STYLE: RenderStyle = {
  preset: "parchment-classic",
  title: "Untitled World",
  showLabels: true,
  showRivers: true,
  showGraticule: false,
  showBorder: true,
  showCompass: true,
  showLegend: true,
  labelDensity: 0.6,
  paperTexture: 0.55,
  hillshadeStrength: 0.55,
  coastHatching: 0.6,
};

export interface CreateDocumentOptions {
  name?: string;
  seed?: number;
  params?: Partial<WorldParams>;
  style?: Partial<RenderStyle>;
  overrides?: WorldDocument["overrides"];
  settlements?: WorldDocument["settlements"];
  labels?: WorldDocument["labels"];
}

let idCounter = 0;

export function createDefaultDocument(options: CreateDocumentOptions = {}): WorldDocument {
  const now = new Date().toISOString();
  const name = options.name ?? "Untitled World";
  const seed = options.seed ?? Math.floor(Math.random() * 1e9);
  idCounter += 1;
  return {
    version: 1,
    id: `world-${Date.now().toString(36)}-${idCounter}`,
    name,
    seed,
    params: { ...DEFAULT_PARAMS, ...options.params },
    style: { ...DEFAULT_STYLE, title: name, ...options.style },
    overrides: options.overrides ?? { elevation: [], riverForce: [], biome: [], hiddenIds: [] },
    settlements: options.settlements ?? [],
    labels: options.labels ?? [],
    createdAt: now,
    updatedAt: now,
  };
}
