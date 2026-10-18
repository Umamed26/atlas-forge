/**
 * DEV-only QA hooks for Playwright / manual debugging.
 *
 *   window.__atlasDebug.getDocument()  // current WorldDocument (single source of truth)
 *   window.__atlasDebug.getSummary()   // compact state snapshot for assertions
 *   window.__atlasDebugDocument        // live getter, for scripts that want the doc directly
 */
import { BASE_RENDER_SIZE } from "./constants";
import { countOverrides } from "./documentIO";
import { collectPlaces, generatePlaceName, uniquePlaceName, type PlaceEntry } from "./places";
import { assessReadabilityLocal } from "./readability";
import { LOCK_KEYS, seedLabel } from "./stageSeeds";
import { scenarioById } from "./scenarios";
import {
  hitTestPlaces,
  placeHitBoxesForDebug,
  type PlaceHitBox,
  type PlaceHitBoxDebugInfo,
} from "./placeHitTest";
import { getShortcutList, type ShortcutDef } from "./shortcuts";
import { useViewStore } from "../state/viewStore";
import { useWorldStore } from "../state/worldStore";

export interface AtlasDebugSummary {
  version: string;
  name: string;
  seed: number;
  paramsGridSize: number;
  namingLanguage: string;
  stylePreset: string;
  tool: string;
  elevationMode: string;
  brushRadius: number;
  ready: boolean;
  generation: {
    phase: string;
    seq: number;
    durationMs: number | null;
    error: string | null;
    progress: { stage: string; progress: number } | null;
    queuedLatest: boolean;
  };
  render: { rendering: boolean; lastMs: number | null; baseVersion: number; error: string | null };
  layers: {
    size: number;
    seed: number;
    totalMs: number;
    landFraction: number;
    settlements: number;
    labels: number;
  } | null;
  overrides: ReturnType<typeof countOverrides>;
  riverForce: { id: string; points: number; width: number }[];
  history: { undo: number; redo: number };
  view: {
    scale: number;
    zoomPercent: number;
    offsetX: number;
    offsetY: number;
    viewportW: number;
    viewportH: number;
    baseSize: number;
  };
  save: { phase: string; savedAt: number | null; error: string | null };
  server: { phase: string; latencyMs: number | null; maxSize: number | null };
  autosaveRestored: boolean;
  exportSize: number;
  hitBoxesSource: string | null;
  hitBoxCount: number;
  perf: {
    hitTestMs: number | null;
    lastGenerationMs: number | null;
    lastRenderMs: number | null;
  };
  autosaveRecovery: { pending: boolean; hasBackup: boolean } | null;
  scenarioId: string;
  scenarioName: string;
  locks: Record<string, boolean>;
  generatedSummary: string;
  generationKind: string;
  generationHistoryCount: number;
  historyCount: number;
  activePreset: string;
  draftActive: boolean;
  draftRequests: number;
  draftResults: number;
  requestSizeOverride: number | null;
  readability: { score: number; level: string; issues: string[] } | null;
  readabilityDismissed: boolean;
  layerSignature: { height: number; river: number; biome: number };
  places: {
    selected: { id: string; entity: string } | null;
    renaming: { id: string; entity: string } | null;
    armed: boolean;
    mode: string;
    settlementKind: string;
    labelKind: string;
    nameDraft: string;
    visibleSettlements: number;
    visibleLabels: number;
    hiddenCount: number;
    hiddenIds: string[];
    userSettlements: number;
    userLabels: number;
    list: Pick<PlaceEntry, "id" | "entity" | "name" | "type" | "x" | "y" | "pinned" | "userAdded" | "hidden">[];
  };
}

export interface AtlasDebugApi {
  version: string;
  getDocument: () => ReturnType<typeof useWorldStore.getState>["document"];
  getLayers: () => ReturnType<typeof useWorldStore.getState>["layers"];
  getSummary: () => AtlasDebugSummary;
  regenerate: () => void;
  fit: () => void;
  zoom: (factor: number) => void;
  oneToOne: () => void;
  /** Renderer-sourced (or marker-fallback) place boxes, image/world/screen. */
  getPlaceHitBoxes: () => PlaceHitBoxDebugInfo[];
  /** Single-source keyboard shortcut list (also drives HelpDialog). */
  getShortcuts: () => ShortcutDef[];
  /** Deterministic naming demo for E2E / README parity checks. */
  getNamingDemo: () => {
    deterministic: string[];
    deduped: string;
    randomSample: string;
  };
  getGenerationHistory: () => {
    id: string;
    seed: number;
    scenarioId: string;
    thumbnail: string;
    createdAt: number;
  }[];
  quickGenerate: () => void;
  cancelGeneration: () => void;
  /** Stable FNV-1a fingerprints for layer-identity E2E assertions. */
  getLayerSignature: () => {
    height: number;
    ocean: number;
    river: number;
    biome: number;
    temperature: number;
  } | null;
  /** Explicit per-stage seeds currently stored on the document (may be absent). */
  getStageSeeds: () => {
    terrain?: number;
    hydrology?: number;
    climate?: number;
    human?: number;
  } | null;
  /** Pure hit-priority probe using the same hitTestPlaces function as the UI. */
  testHitPriority: () => {
    hitId: string | null;
    usedBoxes: boolean;
    candidates: number;
    ms: number;
  };
}

declare global {
  interface Window {
    __atlasDebug?: AtlasDebugApi;
    __atlas?: AtlasDebugApi;
    __atlasDebugDocument?: ReturnType<typeof useWorldStore.getState>["document"];
  }
}

/** FNV-1a 32-bit over the full typed array (O(n) but computed on demand only). */
function fnv1a32(array: ArrayLike<number>): number {
  let hash = 2166136261;
  for (let index = 0; index < array.length; index += 1) {
    const value = Math.round(Number(array[index]) * 1000) | 0;
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sampleSignature(array: Float32Array | Uint8Array, step = 4093): number {
  let hash = 2166136261;
  for (let index = 0; index < array.length; index += step) {
    const value = Math.round(Number(array[index]) * 1000) | 0;
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSummary(): AtlasDebugSummary {
  const state = useWorldStore.getState();
  const view = useViewStore.getState();
  const layers = state.layers;
  const placeCollections = collectPlaces(state.document, layers);
  const visibleSettlements = placeCollections.visible.filter(
    (entry) => entry.entity === "settlement",
  );
  const localFallback = assessReadabilityLocal(state.document, state.layers);
  const localFallbackReport = localFallback
    ? {
        score: 100 - localFallback.issues.length * 15,
        level: localFallback.level,
        issues: localFallback.issues.map((issue) => issue.id),
      }
    : null;
  return {
    version: "m6",
    name: state.document.name,
    seed: state.document.seed,
    paramsGridSize: state.document.params.gridSize,
    namingLanguage: state.document.params.namingLanguage,
    stylePreset: state.document.style.preset,
    tool: state.tool,
    elevationMode: state.brush.elevationMode,
    brushRadius: state.brush.radius,
    ready: layers !== null,
    generation: {
      phase: state.generation.phase,
      seq: state.generation.seq,
      durationMs: state.generation.durationMs,
      error: state.generation.error,
      progress: state.generation.progress
        ? {
            stage: state.generation.progress.stage,
            progress: state.generation.progress.progress,
          }
        : null,
      queuedLatest: state.generation.queuedLatest,
    },
    render: {
      rendering: state.render.rendering,
      lastMs: state.render.lastMs,
      baseVersion: state.render.baseVersion,
      error: state.render.error,
    },
    layers: layers
      ? {
          size: layers.size,
          seed: layers.seed,
          totalMs: layers.stats.totalMs,
          landFraction: layers.stats.landFraction,
          settlements: layers.settlements.length,
          labels: layers.autoLabels.length,
        }
      : null,
    overrides: countOverrides(state.document.overrides),
    riverForce: state.document.overrides.riverForce.map((river) => ({
      id: river.id,
      points: river.points.length,
      width: river.width,
    })),
    history: { undo: state.historyPast.length, redo: state.historyFuture.length },
    view: {
      scale: view.scale,
      zoomPercent: Math.round(view.scale * 100),
      offsetX: view.offsetX,
      offsetY: view.offsetY,
      viewportW: view.viewportW,
      viewportH: view.viewportH,
      baseSize: BASE_RENDER_SIZE,
    },
    save: {
      phase: state.save.phase,
      savedAt: state.save.savedAt,
      error: state.save.error,
    },
    server: {
      phase: state.server.phase,
      latencyMs: state.server.latencyMs,
      maxSize: state.server.maxSize,
    },
    autosaveRestored: state.restoredFromAutosave,
    exportSize: state.exportSize,
    hitBoxesSource: state.hitBoxesSource,
    hitBoxCount: state.hitBoxes?.length ?? 0,
    perf: {
      hitTestMs: state.perf.hitTestMs,
      lastGenerationMs: state.perf.lastGenerationMs,
      lastRenderMs: state.perf.lastRenderMs,
    },
    autosaveRecovery: state.autosaveRecovery
      ? { pending: true, hasBackup: state.autosaveRecovery.hasBackup }
      : null,
    scenarioId: state.scenarioId,
    scenarioName: scenarioById(state.scenarioId).name,
    locks: Object.fromEntries(LOCK_KEYS.map((key) => [key, state.locks[key]])),
    generatedSummary: `${scenarioById(state.scenarioId).name} · ${seedLabel(state.document.seed)}`,
    generationKind: state.generation.kind,
    generationHistoryCount: state.generationHistory.length,
    historyCount: state.generationHistory.length,
    activePreset: state.scenarioId,
    draftActive: state.draftActive,
    draftRequests: state.draftRequests,
    draftResults: state.draftResults,
    requestSizeOverride: state.requestSizeOverride,
    readability: state.readability
      ? {
          score: state.readability.score,
          level: state.readability.issues.some((issue) => issue.severity === "fail")
            ? "fail"
            : "warn",
          issues: state.readability.issues.map((issue) => issue.id),
        }
      : localFallbackReport,
    readabilityDismissed: state.readabilityDismissed,
    layerSignature: layers
      ? {
          height: sampleSignature(layers.height),
          river: sampleSignature(layers.river),
          biome: sampleSignature(layers.biome),
        }
      : { height: 0, river: 0, biome: 0 },
    places: {
      selected: state.selectedPlace ? { ...state.selectedPlace } : null,
      renaming: state.placeRename ? { ...state.placeRename } : null,
      armed: state.placeTool.armed,
      mode: state.placeTool.mode,
      settlementKind: state.placeTool.settlementKind,
      labelKind: state.placeTool.labelKind,
      nameDraft: state.placeTool.name,
      visibleSettlements: visibleSettlements.length,
      visibleLabels: placeCollections.visible.length - visibleSettlements.length,
      hiddenCount: placeCollections.hidden.length,
      hiddenIds: [...placeCollections.hiddenIds],
      userSettlements: state.document.settlements?.length ?? 0,
      userLabels: state.document.labels?.length ?? 0,
      list: placeCollections.visible.map((entry) => ({
        id: entry.id,
        entity: entry.entity,
        name: entry.name,
        type: entry.type,
        x: entry.x,
        y: entry.y,
        pinned: entry.pinned,
        userAdded: entry.userAdded,
        hidden: entry.hidden,
      })),
    },
  };
}

export function installDebugApi(): void {
  const api: AtlasDebugApi = {
    version: "m6",
    getDocument: () => useWorldStore.getState().document,
    getLayers: () => useWorldStore.getState().layers,
    getSummary: buildSummary,
    regenerate: () => useWorldStore.getState().requestGeneration("now"),
    fit: () => useViewStore.getState().fit(),
    zoom: (factor: number) => useViewStore.getState().zoomBy(factor),
    oneToOne: () => useViewStore.getState().oneToOne(),
    getPlaceHitBoxes: () => {
      const state = useWorldStore.getState();
      const view = useViewStore.getState();
      const boxes = state.hitBoxes ?? [];
      return placeHitBoxesForDebug(
        boxes,
        { scale: view.scale, offsetX: view.offsetX, offsetY: view.offsetY },
        BASE_RENDER_SIZE,
      );
    },
    getShortcuts: () => getShortcutList(),
    getNamingDemo: () => {
      const fixedRng = () => 0.42;
      return {
        deterministic: [
          generatePlaceName("settlement", "port", fixedRng),
          generatePlaceName("settlement", "port", fixedRng),
          generatePlaceName("label", "water", fixedRng),
        ],
        deduped: uniquePlaceName("新港", ["新港", "新港-2"]),
        randomSample: generatePlaceName("settlement", "city"),
      };
    },
    getGenerationHistory: () =>
      useWorldStore.getState().generationHistory.map((entry) => ({
        id: entry.id,
        seed: entry.document.seed,
        scenarioId: entry.scenarioId,
        thumbnail: entry.thumbnail,
        createdAt: entry.createdAt,
      })),
    quickGenerate: () => useWorldStore.getState().requestQuickGeneration(),
    cancelGeneration: () => useWorldStore.getState().requestCancelGeneration(),
    getLayerSignature: () => {
      const layers = useWorldStore.getState().layers;
      if (!layers) return null;
      return {
        height: fnv1a32(layers.height),
        ocean: fnv1a32(layers.ocean),
        river: fnv1a32(layers.river),
        biome: fnv1a32(layers.biome),
        temperature: fnv1a32(layers.temperature),
      };
    },
    getStageSeeds: () => {
      const seeds = (useWorldStore.getState().document.params as { stageSeeds?: Record<string, number> })
        .stageSeeds;
      return seeds ? { ...seeds } : null;
    },
    testHitPriority: () => {
      const entries = [
        {
          id: "low-box",
          entity: "label" as const,
          name: "低层",
          type: "custom" as const,
          x: 0.5,
          y: 0.5,
          pinned: true,
          userAdded: false,
          hidden: false,
        },
        {
          id: "high-box",
          entity: "label" as const,
          name: "顶层",
          type: "custom" as const,
          x: 0.5,
          y: 0.5,
          pinned: true,
          userAdded: false,
          hidden: false,
        },
      ];
      const boxes: PlaceHitBox[] = [
        { id: "low-box", entity: "label", x: 480, y: 490, width: 40, height: 20, drawOrder: 3 },
        { id: "high-box", entity: "label", x: 490, y: 495, width: 40, height: 20, drawOrder: 9 },
      ];
      const result = hitTestPlaces({
        entries,
        boxes,
        imagePoint: { x: 500, y: 500 },
        viewportWorld: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        padding: 4,
        fallbackThresholdWorld: 0.02,
      });
      return {
        hitId: result.hit?.id ?? null,
        usedBoxes: result.usedBoxes,
        candidates: result.candidates,
        ms: result.ms,
      };
    },
  };
  window.__atlasDebug = api;
  window.__atlas = api;
  Object.defineProperty(window, "__atlasDebugDocument", {
    configurable: true,
    get: () => useWorldStore.getState().document,
  });
}
