import type {
  DecorConfig,
  DecorId,
  Decorations,
  RenderStyle,
  WorldDocument,
  WorldParams,
} from "./types";

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
  terrainModel: "fbm",
};

/**
 * Default map chrome. Every element can be hidden; titles use the world name
 * unless overridden. Anchors follow traditional cartography (title top-centre,
 * compass top-right, scale bottom-left, legend bottom-right).
 */
export const DEFAULT_DECORATIONS: Required<Record<DecorId, DecorConfig>> = {
  title: { visible: true, anchor: "top-center" },
  compass: { visible: true, anchor: "top-right" },
  scaleBar: { visible: true, anchor: "bottom-left" },
  legend: { visible: true, anchor: "bottom-right" },
  graticule: { visible: false },
  border: { visible: true },
  credits: { visible: true, anchor: "bottom-center", text: "Atlas Forge" },
};

/** Merge partial/user decorations with the defaults (per element). */
export function resolveDecorations(decorations?: Decorations): Required<Record<DecorId, DecorConfig>> {
  const resolved = {} as Required<Record<DecorId, DecorConfig>>;
  for (const id of Object.keys(DEFAULT_DECORATIONS) as DecorId[]) {
    resolved[id] = { ...DEFAULT_DECORATIONS[id], ...(decorations?.[id] ?? {}) };
  }
  return resolved;
}

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
  decorations: { ...DEFAULT_DECORATIONS },
};

export interface CreateDocumentOptions {
  name?: string;
  seed?: number;
  algorithmVersion?: number;
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
    algorithmVersion: options.algorithmVersion ?? 2,
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
