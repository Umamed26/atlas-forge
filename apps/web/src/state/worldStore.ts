/**
 * World editor state (zustand).
 *
 * WorldDocument is the single source of truth; layers and render output are
 * derived and never persisted. Simulated changes bump `simTick` (the worker
 * pipeline effect listens to it) while style / metadata changes only bump
 * `renderTick` so a style tweak never re-simulates the world.
 */
import {
  DEFAULT_STYLE,
  createDefaultDocument,
  type BiomeId,
  type BiomeStamp,
  type ElevationMode,
  type ElevationStamp,
  type ProgressUpdate,
  type RenderStyle,
  type RiverForcePath,
  type WorldDocument,
  type WorldLayers,
  type WorldParams,
} from "@atlas/core";
import { create } from "zustand";

import {
  DEFAULT_PARAM_VALUES,
  HISTORY_CAP,
  MAX_BIOME_STAMPS,
  MAX_ELEVATION_STAMPS,
  MAX_NAME_LENGTH,
  MAX_RIVER_PATHS,
  MAX_RIVER_POINTS,
  STYLE_PRESETS,
  type ToolId,
} from "../lib/constants";
import {
  cloneDocumentForHistory,
  loadAutosave,
} from "../lib/documentIO";
import { clamp, clamp01, randomSeed, uid } from "../lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────

export type SimTrigger = "now" | "debounce";
export type GenerationPhase = "idle" | "queued" | "generating" | "error";
export type ToastKind = "info" | "success" | "error";
export type SavePhase = "idle" | "saving" | "saved" | "error";
export type ServerPhase = "unknown" | "online" | "offline";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface GenerationStatus {
  phase: GenerationPhase;
  seq: number;
  progress: ProgressUpdate | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  /** A newer document was submitted while the current job is still running. */
  queuedLatest: boolean;
}

export interface RenderStatus {
  rendering: boolean;
  lastMs: number | null;
  error: string | null;
  /** Increments every time a new base map bitmap is installed. */
  baseVersion: number;
}

export interface SaveStatus {
  phase: SavePhase;
  savedAt: number | null;
  error: string | null;
}

export interface ServerStatus {
  phase: ServerPhase;
  latencyMs: number | null;
  maxSize: number | null;
  checkedAt: number | null;
}

export interface BrushState {
  /** Normalized radius (fraction of the map edge). */
  radius: number;
  /** raise / lower delta amplitude in 0..0.4. */
  strength: number;
  elevationMode: ElevationMode;
  /** Absolute 0..1 height used in lock mode. */
  lockHeight: number;
  biome: BiomeId;
  /** Normalized forced-river width. */
  riverWidth: number;
}

export interface RiverDraft {
  active: boolean;
  points: [number, number][];
}

export interface CommitOptions {
  history?: "push" | "pending" | "none";
  sim?: SimTrigger;
  render?: boolean;
}

export interface WorldStore {
  // ── document & derived ──
  document: WorldDocument;
  layers: WorldLayers | null;
  layersDocument: WorldDocument | null;
  lastAppliedSeq: number;
  baseCanvas: HTMLCanvasElement | null;
  restoredFromAutosave: boolean;

  // ── request tickets (consumed by effects in App) ──
  simTick: number;
  simMode: SimTrigger;
  renderTick: number;
  pipelineResetTick: number;

  // ── UI state ──
  generation: GenerationStatus;
  render: RenderStatus;
  save: SaveStatus;
  server: ServerStatus;
  historyPast: WorldDocument[];
  historyFuture: WorldDocument[];
  tool: ToolId;
  brush: BrushState;
  riverDraft: RiverDraft;
  toast: ToastMessage | null;

  // ── document mutations ──
  commitDocument(next: WorldDocument, options?: CommitOptions): void;
  beginInteraction(): void;
  endInteraction(): void;
  pushHistorySnapshot(document: WorldDocument): void;
  undo(): void;
  redo(): void;

  updateParams(patch: Partial<WorldParams>, options?: { history?: CommitOptions["history"]; sim?: SimTrigger }): void;
  resetParams(keys?: (keyof WorldParams)[]): void;
  updateStyle(patch: Partial<RenderStyle>, options?: { history?: CommitOptions["history"] }): void;
  applyPreset(preset: RenderStyle["preset"]): void;
  resetStyle(): void;
  setName(name: string): void;
  setTitle(title: string): void;
  setSeed(seed: number, options?: { history?: CommitOptions["history"] }): void;
  rerollSeed(): void;
  importDocument(document: WorldDocument): void;

  // ── override edits ──
  addElevationStamps(stamps: ElevationStamp[]): void;
  addBiomeStamps(stamps: BiomeStamp[]): void;
  commitRiverDraft(): void;
  deleteRiver(id: string): void;
  clearOverrides(): void;

  // ── tool state ──
  setTool(tool: ToolId): void;
  setBrush(patch: Partial<BrushState>): void;
  setElevationMode(mode: ElevationMode): void;
  setBiome(biome: BiomeId): void;
  addRiverPoint(x: number, y: number): void;
  undoRiverPoint(): void;
  clearRiverDraft(): void;

  // ── generation lifecycle (called by the worker client) ──
  requestGeneration(mode: SimTrigger): void;
  requestRender(): void;
  requestPipelineReset(): void;
  generationQueued(seq: number): void;
  generationStarted(seq: number): void;
  generationProgress(seq: number, update: ProgressUpdate): void;
  generationSucceeded(seq: number, layers: WorldLayers, document: WorldDocument): void;
  generationFailed(seq: number, message: string): void;
  clearGenerationError(): void;

  // ── render lifecycle ──
  renderStarted(): void;
  renderDone(canvas: HTMLCanvasElement, elapsedMs: number): void;
  renderFailed(message: string): void;
  clearBaseCanvas(): void;

  // ── save / server / toast ──
  markSaving(): void;
  markSaved(savedAt: number): void;
  markSaveError(message: string): void;
  setServerStatus(status: Omit<ServerStatus, "checkedAt"> & { checkedAt?: number }): void;
  pushToast(kind: ToastKind, text: string): void;
  dismissToast(id: number): void;
}

// ── Initial document (restored from the last autosave when available) ────

interface InitialDocument {
  document: WorldDocument;
  restoredFromAutosave: boolean;
}

function createInitialDocument(): InitialDocument {
  const restored = loadAutosave();
  if (restored) return { document: restored, restoredFromAutosave: true };
  return {
    document: createDefaultDocument({ name: "Aetheris", seed: 20261018 }),
    restoredFromAutosave: false,
  };
}

// ── History helpers ───────────────────────────────────────────────────────

interface InteractionState {
  active: boolean;
  snapshot: WorldDocument | null;
}

let interaction: InteractionState = { active: false, snapshot: null };

function resetInteraction(): void {
  interaction = { active: false, snapshot: null };
}

/** Push the pending interaction snapshot (one history entry per drag/typing
 *  session). Falls back to the current document when no interaction is open. */
function commitPendingHistory(get: () => WorldStore): boolean {
  if (!interaction.active) return false;
  const snapshot = interaction.snapshot;
  interaction.snapshot = null;
  if (!snapshot) return true;
  get().pushHistorySnapshot(snapshot);
  return true;
}

let toastSeq = 0;

function makeToast(kind: ToastKind, text: string): ToastMessage {
  toastSeq += 1;
  return { id: toastSeq, kind, text };
}

const TOOL_IDS = new Set<ToolId>(["pan", "elevation", "river", "biome"]);

// ── Store ─────────────────────────────────────────────────────────────────

export const useWorldStore = create<WorldStore>()((set, get) => {
  const initial = createInitialDocument();

  return {
    document: initial.document,
    layers: null,
    layersDocument: null,
    lastAppliedSeq: 0,
    baseCanvas: null,
    restoredFromAutosave: initial.restoredFromAutosave,

    simTick: 0,
    simMode: "debounce",
    renderTick: 0,
    pipelineResetTick: 0,

    generation: {
      phase: "idle",
      seq: 0,
      progress: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      queuedLatest: false,
    },
    render: { rendering: false, lastMs: null, error: null, baseVersion: 0 },
    save: { phase: "idle", savedAt: null, error: null },
    server: { phase: "unknown", latencyMs: null, maxSize: null, checkedAt: null },
    historyPast: [],
    historyFuture: [],
    tool: "pan",
    brush: {
      radius: 0.035,
      strength: 0.18,
      elevationMode: "raise",
      lockHeight: 0.58,
      biome: 5,
      riverWidth: 0.006,
    },
    riverDraft: { active: false, points: [] },
    toast: null,

    // ── history ────────────────────────────────────────────────────────
    beginInteraction: () => {
      if (interaction.active) return;
      interaction = {
        active: true,
        snapshot: cloneDocumentForHistory(get().document),
      };
    },

    endInteraction: () => {
      interaction = { active: false, snapshot: null };
    },

    pushHistorySnapshot: (document) => {
      const snapshot = cloneDocumentForHistory(document);
      set((state) => {
        const past =
          state.historyPast.length >= HISTORY_CAP
            ? state.historyPast.slice(state.historyPast.length - HISTORY_CAP + 1)
            : state.historyPast.slice();
        past.push(snapshot);
        return { historyPast: past, historyFuture: [] };
      });
    },

    commitDocument: (next, options = {}) => {
      const current = get().document;
      if (next === current) return;
      const historyMode = options.history ?? "none";
      if (historyMode === "push") {
        resetInteraction();
        get().pushHistorySnapshot(current);
      } else if (historyMode === "pending") {
        if (!commitPendingHistory(get)) get().pushHistorySnapshot(current);
      }
      set({
        document: { ...next, updatedAt: new Date().toISOString() },
        historyFuture: [],
      });
      if (options.sim) get().requestGeneration(options.sim);
      if (options.render) get().requestRender();
    },

    undo: () => {
      const { historyPast, historyFuture, document } = get();
      if (historyPast.length === 0) return;
      resetInteraction();
      const previous = historyPast[historyPast.length - 1];
      set({
        document: { ...previous, updatedAt: new Date().toISOString() },
        historyPast: historyPast.slice(0, -1),
        historyFuture: [cloneDocumentForHistory(document), ...historyFuture].slice(0, HISTORY_CAP),
        simTick: get().simTick + 1,
        simMode: "now",
        renderTick: get().renderTick + 1,
        toast: makeToast("info", "已撤销"),
      });
    },

    redo: () => {
      const { historyPast, historyFuture, document } = get();
      if (historyFuture.length === 0) return;
      resetInteraction();
      const next = historyFuture[0];
      set({
        document: { ...next, updatedAt: new Date().toISOString() },
        historyPast: [...historyPast, cloneDocumentForHistory(document)].slice(-HISTORY_CAP),
        historyFuture: historyFuture.slice(1),
        simTick: get().simTick + 1,
        simMode: "now",
        renderTick: get().renderTick + 1,
        toast: makeToast("info", "已重做"),
      });
    },

    // ── parameters ─────────────────────────────────────────────────────
    updateParams: (patch, options = {}) => {
      const { document } = get();
      const params = { ...document.params, ...patch };
      get().commitDocument(
        { ...document, params },
        {
          history: options.history ?? "pending",
          sim: options.sim ?? "debounce",
        },
      );
    },

    resetParams: (keys) => {
      const { document } = get();
      const params = { ...document.params };
      const targetKeys: (keyof WorldParams)[] =
        keys ?? (Object.keys(DEFAULT_PARAM_VALUES) as (keyof WorldParams)[]);
      const mutable = params as unknown as Record<string, unknown>;
      for (const key of targetKeys) {
        mutable[key] = DEFAULT_PARAM_VALUES[key];
      }
      get().commitDocument({ ...document, params }, { history: "push", sim: "now" });
      get().pushToast("info", "已恢复默认生成参数");
    },

    // ── style / metadata (render only) ─────────────────────────────────
    updateStyle: (patch, options = {}) => {
      const { document } = get();
      get().commitDocument(
        { ...document, style: { ...document.style, ...patch } },
        { history: options.history ?? "pending", render: true },
      );
    },

    applyPreset: (preset) => {
      const { document } = get();
      const presetDef = STYLE_PRESETS[preset];
      if (!presetDef) return;
      get().commitDocument(
        {
          ...document,
          style: { ...document.style, ...presetDef.style, preset },
        },
        { history: "push", render: true },
      );
      get().pushToast("info", `风格预设：${presetDef.label}`);
    },

    resetStyle: () => {
      const { document } = get();
      get().commitDocument(
        {
          ...document,
          style: {
            ...DEFAULT_STYLE,
            ...STYLE_PRESETS["parchment-classic"].style,
            title: document.style.title,
          },
        },
        { history: "push", render: true },
      );
      get().pushToast("info", "已恢复默认风格");
    },

    setName: (name) => {
      const { document } = get();
      const trimmed = name.slice(0, MAX_NAME_LENGTH);
      get().commitDocument(
        {
          ...document,
          name: trimmed,
          style: { ...document.style, title: trimmed },
        },
        { history: "pending", render: true },
      );
    },

    setTitle: (title) => {
      const { document } = get();
      get().commitDocument(
        { ...document, style: { ...document.style, title: title.slice(0, MAX_NAME_LENGTH) } },
        { history: "pending", render: true },
      );
    },

    setSeed: (seed, options = {}) => {
      const { document } = get();
      const nextSeed = Math.round(clamp(seed, 0, 999_999_999));
      if (nextSeed === document.seed) return;
      get().commitDocument(
        { ...document, seed: nextSeed },
        { history: options.history ?? "push", sim: "now" },
      );
    },

    rerollSeed: () => {
      const seed = randomSeed();
      get().setSeed(seed);
      get().pushToast("info", `新种子：${seed}`);
    },

    importDocument: (document) => {
      resetInteraction();
      get().pushHistorySnapshot(get().document);
      set({
        document: {
          ...document,
          style: { ...document.style, title: document.name },
          updatedAt: new Date().toISOString(),
        },
        historyFuture: [],
        riverDraft: { active: false, points: [] },
        simTick: get().simTick + 1,
        simMode: "now",
        toast: makeToast("success", `已导入世界「${document.name || "未命名"}」`),
      });
    },

    // ── overrides ──────────────────────────────────────────────────────
    addElevationStamps: (stamps) => {
      if (stamps.length === 0) return;
      const { document } = get();
      const existing = document.overrides.elevation;
      const remaining = MAX_ELEVATION_STAMPS - existing.length;
      if (remaining <= 0) {
        get().pushToast("error", `海拔编辑点已达上限（${MAX_ELEVATION_STAMPS}），请先清空部分编辑`);
        return;
      }
      const accepted = stamps.slice(0, remaining);
      get().commitDocument(
        {
          ...document,
          overrides: { ...document.overrides, elevation: existing.concat(accepted) },
        },
        { history: "pending", sim: "now" },
      );
      if (accepted.length < stamps.length) {
        get().pushToast("error", "部分海拔编辑点超出上限，已被截断");
      }
    },

    addBiomeStamps: (stamps) => {
      if (stamps.length === 0) return;
      const { document } = get();
      const existing = document.overrides.biome;
      const remaining = MAX_BIOME_STAMPS - existing.length;
      if (remaining <= 0) {
        get().pushToast("error", `群系编辑点已达上限（${MAX_BIOME_STAMPS}），请先清空部分编辑`);
        return;
      }
      const accepted = stamps.slice(0, remaining);
      get().commitDocument(
        {
          ...document,
          overrides: { ...document.overrides, biome: existing.concat(accepted) },
        },
        { history: "pending", sim: "now" },
      );
      if (accepted.length < stamps.length) {
        get().pushToast("error", "部分群系编辑点超出上限，已被截断");
      }
    },

    commitRiverDraft: () => {
      const { riverDraft, brush, document } = get();
      if (riverDraft.points.length < 2) {
        get().pushToast("error", "强制河道至少需要两个节点");
        return;
      }
      if (document.overrides.riverForce.length >= MAX_RIVER_PATHS) {
        get().pushToast("error", `强制河道数量已达上限（${MAX_RIVER_PATHS}）`);
        return;
      }
      const path: RiverForcePath = {
        id: uid("river"),
        points: riverDraft.points.map(([x, y]) => [x, y] as [number, number]),
        width: brush.riverWidth,
      };
      set({ riverDraft: { active: false, points: [] } });
      get().commitDocument(
        {
          ...document,
          overrides: {
            ...document.overrides,
            riverForce: [...document.overrides.riverForce, path],
          },
        },
        { history: "push", sim: "now" },
      );
      get().pushToast("success", `已添加强制河道（${path.points.length} 个节点），正在重新生成…`);
    },

    deleteRiver: (id) => {
      const { document } = get();
      const next = document.overrides.riverForce.filter((river) => river.id !== id);
      if (next.length === document.overrides.riverForce.length) return;
      get().commitDocument(
        { ...document, overrides: { ...document.overrides, riverForce: next } },
        { history: "push", sim: "now" },
      );
      get().pushToast("info", "已删除强制河道");
    },

    clearOverrides: () => {
      const { document } = get();
      const overrides = document.overrides;
      if (
        overrides.elevation.length === 0 &&
        overrides.riverForce.length === 0 &&
        overrides.biome.length === 0
      ) {
        get().pushToast("info", "当前没有画笔编辑需要清空");
        return;
      }
      get().commitDocument(
        {
          ...document,
          overrides: { ...overrides, elevation: [], riverForce: [], biome: [] },
        },
        { history: "push", sim: "now" },
      );
      get().pushToast("info", "已清空全部画笔编辑，正在重新生成…");
    },

    // ── tools ──────────────────────────────────────────────────────────
    setTool: (tool) => {
      if (!TOOL_IDS.has(tool)) return;
      set({ tool });
    },

    setBrush: (patch) => {
      const next: Partial<BrushState> = { ...patch };
      if (patch.radius !== undefined) next.radius = clamp(patch.radius, 0.003, 0.2);
      if (patch.strength !== undefined) next.strength = clamp(patch.strength, 0.02, 0.4);
      if (patch.lockHeight !== undefined) next.lockHeight = clamp01(patch.lockHeight);
      if (patch.riverWidth !== undefined) next.riverWidth = clamp(patch.riverWidth, 0.0005, 0.04);
      set((state) => ({ brush: { ...state.brush, ...next } }));
    },

    setElevationMode: (mode) => {
      set((state) => ({ brush: { ...state.brush, elevationMode: mode } }));
    },

    setBiome: (biome) => {
      set((state) => ({ brush: { ...state.brush, biome } }));
    },

    addRiverPoint: (x, y) => {
      const { riverDraft } = get();
      const points = riverDraft.points;
      const last = points[points.length - 1];
      const px = clamp01(x);
      const py = clamp01(y);
      if (last && Math.hypot(last[0] - px, last[1] - py) < 0.004) return;
      if (points.length >= MAX_RIVER_POINTS) {
        get().pushToast("error", `单条强制河道最多 ${MAX_RIVER_POINTS} 个节点`);
        return;
      }
      set({ riverDraft: { active: true, points: [...points, [px, py]] } });
    },

    undoRiverPoint: () => {
      const { riverDraft } = get();
      if (riverDraft.points.length === 0) return;
      const points = riverDraft.points.slice(0, -1);
      set({ riverDraft: { active: points.length > 0, points } });
    },

    clearRiverDraft: () => {
      set({ riverDraft: { active: false, points: [] } });
    },

    // ── generation lifecycle ───────────────────────────────────────────
    requestGeneration: (mode) => {
      set((state) => ({ simTick: state.simTick + 1, simMode: mode }));
    },

    requestRender: () => {
      set((state) => ({ renderTick: state.renderTick + 1 }));
    },

    requestPipelineReset: () => {
      set((state) => ({ pipelineResetTick: state.pipelineResetTick + 1 }));
    },

    generationQueued: (seq) => {
      set((state) => ({
        generation: {
          ...state.generation,
          phase:
            state.generation.phase === "idle" || state.generation.phase === "error"
              ? "queued"
              : state.generation.phase,
          seq,
          error: null,
          queuedLatest: true,
        },
      }));
    },

    generationStarted: (seq) => {
      set({
        generation: {
          phase: "generating",
          seq,
          progress: null,
          error: null,
          startedAt: Date.now(),
          finishedAt: null,
          durationMs: null,
          queuedLatest: false,
        },
      });
    },

    generationProgress: (seq, update) => {
      set((state) => {
        if (state.generation.seq !== seq) return {};
        if (state.generation.phase !== "generating") return {};
        return {
          generation: {
            ...state.generation,
            progress: update,
            queuedLatest: false,
          },
        };
      });
    },

    generationSucceeded: (seq, layers, document) => {
      set((state) => {
        if (seq < state.lastAppliedSeq) return {};
        const now = Date.now();
        const startedAt = state.generation.seq === seq ? state.generation.startedAt : null;
        return {
          layers,
          layersDocument: document,
          lastAppliedSeq: seq,
          generation: {
            phase: "idle",
            seq,
            progress: null,
            error: null,
            startedAt,
            finishedAt: now,
            durationMs: startedAt ? now - startedAt : layers.stats.totalMs,
            queuedLatest: false,
          },
          renderTick: state.renderTick + 1,
        };
      });
    },

    generationFailed: (seq, message) => {
      set((state) => {
        if (seq < state.lastAppliedSeq) return {};
        return {
          generation: {
            ...state.generation,
            phase: "error",
            seq,
            progress: null,
            error: message,
            finishedAt: Date.now(),
            durationMs: state.generation.startedAt
              ? Date.now() - state.generation.startedAt
              : null,
            queuedLatest: false,
          },
          toast: makeToast("error", `生成失败：${message}`),
        };
      });
    },

    clearGenerationError: () => {
      set((state) => ({ generation: { ...state.generation, phase: "idle", error: null } }));
    },

    // ── render lifecycle ───────────────────────────────────────────────
    renderStarted: () => {
      set((state) => ({ render: { ...state.render, rendering: true, error: null } }));
    },

    renderDone: (canvas, elapsedMs) => {
      set((state) => ({
        baseCanvas: canvas,
        render: {
          rendering: false,
          lastMs: elapsedMs,
          error: null,
          baseVersion: state.render.baseVersion + 1,
        },
      }));
    },

    renderFailed: (message) => {
      set((state) => ({
        render: { ...state.render, rendering: false, error: message },
        toast: makeToast("error", `渲染失败：${message}`),
      }));
    },

    clearBaseCanvas: () => {
      set((state) => ({
        baseCanvas: null,
        render: { ...state.render, baseVersion: state.render.baseVersion + 1 },
      }));
    },

    // ── save / server / toast ──────────────────────────────────────────
    markSaving: () => {
      set((state) =>
        state.save.phase === "saving"
          ? {}
          : { save: { ...state.save, phase: "saving", error: null } },
      );
    },

    markSaved: (savedAt) => {
      set({ save: { phase: "saved", savedAt, error: null } });
    },

    markSaveError: (message) => {
      set((state) => ({
        save: { phase: "error", savedAt: state.save.savedAt, error: message },
      }));
    },

    setServerStatus: (status) => {
      set({
        server: {
          phase: status.phase,
          latencyMs: status.latencyMs,
          maxSize: status.maxSize,
          checkedAt: status.checkedAt ?? Date.now(),
        },
      });
    },

    pushToast: (kind, text) => {
      set({ toast: makeToast(kind, text) });
    },

    dismissToast: (id) => {
      set((state) => (state.toast && state.toast.id === id ? { toast: null } : {}));
    },
  };
});

// ── Selectors ─────────────────────────────────────────────────────────────

export const selectDocument = (state: WorldStore) => state.document;
export const selectCanUndo = (state: WorldStore) => state.historyPast.length > 0;
export const selectCanRedo = (state: WorldStore) => state.historyFuture.length > 0;
export const selectGenerationActive = (state: WorldStore) =>
  state.generation.phase === "generating" || state.generation.phase === "queued";
