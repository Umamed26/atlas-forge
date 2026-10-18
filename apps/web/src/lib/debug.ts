/**
 * DEV-only QA hooks for Playwright / manual debugging.
 *
 *   window.__atlasDebug.getDocument()  // current WorldDocument (single source of truth)
 *   window.__atlasDebug.getSummary()   // compact state snapshot for assertions
 *   window.__atlasDebugDocument        // live getter, for scripts that want the doc directly
 */
import { BASE_RENDER_SIZE } from "./constants";
import { countOverrides } from "./documentIO";
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
}

declare global {
  interface Window {
    __atlasDebug?: AtlasDebugApi;
    __atlas?: AtlasDebugApi;
    __atlasDebugDocument?: ReturnType<typeof useWorldStore.getState>["document"];
  }
}

function buildSummary(): AtlasDebugSummary {
  const state = useWorldStore.getState();
  const view = useViewStore.getState();
  const layers = state.layers;
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
  };
  window.__atlasDebug = api;
  window.__atlas = api;
  Object.defineProperty(window, "__atlasDebugDocument", {
    configurable: true,
    get: () => useWorldStore.getState().document,
  });
}
