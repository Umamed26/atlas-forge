/**
 * World editor state (zustand).
 *
 * WorldDocument is the single source of truth; layers and render output are
 * derived and never persisted. Simulated changes bump `simTick` (the worker
 * pipeline effect listens to it) while style / metadata changes only bump
 * `renderTick` so a style tweak never re-simulates the world.
 */
import {
  DEFAULT_PARAMS,
  DEFAULT_STYLE,
  createDefaultDocument,
  type BiomeId,
  type BiomeStamp,
  type ElevationMode,
  type ElevationStamp,
  type ProgressUpdate,
  type RenderStyle,
  type RiverForcePath,
  type LabelKind,
  type MapLabel,
  type Settlement,
  type SettlementKind,
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
  clearAutosave,
  cloneDocumentForHistory,
  loadAutosaveBackup,
  loadAutosaveState,
  saveAutosave,
} from "../lib/documentIO";
import type { PlaceHitBox } from "../lib/placeHitTest";
import {
  MAX_GENERATION_HISTORY,
  createThumbnail,
  type GenerationHistoryEntry,
} from "../lib/history";
import type { ReadabilityReport } from "@atlas/render";
import { assessReadabilityLocal } from "../lib/readability";
import { readAlgorithm, withPlatesAlgorithm } from "../lib/worldAlgorithm";
import {
  SCENARIOS,
  countScenarioParamDiffs,
  findClosestScenarioId,
  randomScenarioId,
  scenarioBaselineParams,
  scenarioById,
} from "../lib/scenarios";
import {
  DEFAULT_LOCKS,
  LOCK_KEYS,
  describeLockToast,
  explicitStageSeeds,
  randomStageSeed,
  seedLabel,
  withStageSeeds,
  type LockKey,
  type LockState,
} from "../lib/stageSeeds";
import {
  readStoredBoolean,
  readStoredString,
  UI_PREF_KEYS,
  writeStoredBoolean,
  writeStoredString,
} from "../lib/uiPrefs";
import {
  collectPlaceNames,
  collectPlaces,
  createUserLabel,
  createUserSettlement,
  generatePlaceName,
  isUserPlaceId,
  uniquePlaceName,
  upsertLabel,
  upsertSettlement,
  type PlaceEntity,
  type PlaceSelection,
} from "../lib/places";
import { clamp, clamp01, randomSeed, uid } from "../lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────

export type SimTrigger = "now" | "debounce";
export type GenerationPhase = "idle" | "queued" | "generating" | "error";
export type ToastKind = "info" | "success" | "error";
export type SavePhase = "idle" | "saving" | "saved" | "error";
export type ServerPhase = "unknown" | "online" | "offline" | "desktop";

export interface ToastAction {
  kind: "export-json" | "recover-autosave";
  label: string;
}

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

export interface PerfMetrics {
  hitTestMs: number | null;
  hitTestAt: number | null;
  lastGenerationMs: number | null;
  lastRenderMs: number | null;
}

export interface AutosaveRecoveryState {
  message: string;
  hasBackup: boolean;
  backupSavedAt: number | null;
}

export type GenerationKind = "full" | "draft";

export interface GenerationStatus {
  phase: GenerationPhase;
  kind: GenerationKind;
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

export type { PlaceEntity, PlaceSelection } from "../lib/places";

export interface PlaceToolState {
  mode: PlaceEntity;
  settlementKind: SettlementKind;
  labelKind: LabelKind;
  name: string;
  armed: boolean;
}

export interface ScenarioRuntimeState {
  scenarioId: string;
}

export interface CommitOptions {
  history?: "push" | "pending" | "none";
  sim?: SimTrigger;
  render?: boolean;
  /** While true the sim request is a 512² draft preview, not a full rebuild. */
  draft?: boolean;
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
  selectedPlace: PlaceSelection | null;
  placeTool: PlaceToolState;
  placeRename: PlaceSelection | null;
  toast: ToastMessage | null;

  // ── v0.5 diagnostics / algorithm ──
  climateOverlay: boolean;

  // ── generation experience (v0.4) ──
  scenarioId: string;
  locks: LockState;
  generationHistory: GenerationHistoryEntry[];
  historyPending: boolean;
  suppressNextHistoryPush: boolean;
  draftActive: boolean;
  draftRequests: number;
  draftResults: number;
  draftLayers: WorldLayers | null;
  draftDocument: WorldDocument | null;
  readability: ReadabilityReport | null;
  readabilityDismissed: boolean;
  readabilityPending: boolean;
  requestSizeOverride: number | null;
  cancelTick: number;
  simKind: GenerationKind;

  // ── polish: export / performance / autosave recovery ──
  exportSize: number;
  perf: PerfMetrics;
  hitBoxes: PlaceHitBox[] | null;
  hitBoxesSource: "renderer" | "marker" | null;
  autosaveRecovery: AutosaveRecoveryState | null;

  // ── document mutations ──
  commitDocument(next: WorldDocument, options?: CommitOptions): void;
  beginInteraction(): void;
  endInteraction(): void;
  pushHistorySnapshot(document: WorldDocument): void;
  undo(): void;
  redo(): void;

  updateParams(patch: Partial<WorldParams>, options?: { history?: CommitOptions["history"]; sim?: SimTrigger; draft?: boolean }): void;
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

  // ── places / labels editing ──
  selectPlace(selection: PlaceSelection | null): void;
  setPlaceMode(mode: PlaceEntity): void;
  setPlaceSettlementKind(kind: SettlementKind): void;
  setPlaceLabelKind(kind: LabelKind): void;
  setPlaceName(name: string): void;
  togglePlaceArmed(): void;
  disarmPlacement(): void;
  beginPlaceRename(id: string, entity: PlaceEntity): void;
  cancelPlaceRename(): void;
  renamePlace(id: string, entity: PlaceEntity, name: string): void;
  movePlace(id: string, entity: PlaceEntity, x: number, y: number): void;
  hidePlace(id: string): void;
  restorePlace(id: string): void;
  deletePlace(id: string, entity: PlaceEntity): void;
  addPlaceAt(x: number, y: number): void;

  // ── polish: export size / perf / hit boxes / autosave recovery ──
  setExportSize(size: number): void;
  recordHitTest(ms: number): void;
  setHitBoxes(boxes: PlaceHitBox[] | null, source: "renderer" | "marker" | null): void;
  dismissAutosaveRecovery(): void;
  recoverAutosave(): void;
  clearCorruptedAutosave(): void;

  // ── v0.5 diagnostics / algorithm ──
  setClimateOverlay(enabled: boolean): void;
  upgradeAlgorithm(): void;
  applyScenario(scenarioId: string, options?: { seed?: number }): void;
  setLock(key: LockKey, locked: boolean): void;
  rerollUnlocked(): void;
  rerollNames(): void;
  requestDraftGeneration(): void;
  requestQuickGeneration(): void;
  requestCancelGeneration(): void;
  markGenerationCancelled(seq: number): void;
  setDraftResult(seq: number, layers: WorldLayers, document: WorldDocument): void;
  noteDraftRequest(): void;
  consumeRequestSizeOverride(): number | null;
  setHistoryPending(pending: boolean): void;
  pushGenerationHistory(entry: GenerationHistoryEntry): void;
  restoreGenerationHistory(id: string): void;
  setReadability(report: ReadabilityReport | null): void;
  dismissReadability(): void;
  setReadabilityPending(pending: boolean): void;

  // ── generation lifecycle (called by the worker client) ──
  requestGeneration(mode: SimTrigger): void;
  requestRender(): void;
  requestPipelineReset(): void;
  generationQueued(seq: number): void;
  generationStarted(seq: number, kind?: GenerationKind): void;
  generationProgress(seq: number, update: ProgressUpdate): void;
  generationSucceeded(seq: number, layers: WorldLayers, document: WorldDocument, meta?: { size?: number }): void;
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
  pushToast(kind: ToastKind, text: string, action?: ToastAction): void;
  dismissToast(id: number): void;
}

// ── Initial document (restored from the last autosave when available) ────

interface InitialDocument {
  document: WorldDocument;
  restoredFromAutosave: boolean;
  autosaveRecovery: AutosaveRecoveryState | null;
}

function createInitialDocument(): InitialDocument {
  const fallback = () =>
    createDefaultDocument({ name: "Aetheris", seed: 20261018 });
  const state = loadAutosaveState();
  if (state.corrupted) {
    return {
      document: fallback(),
      restoredFromAutosave: false,
      autosaveRecovery: {
        message: state.corruptedMessage ?? "浏览器自动存档已损坏",
        hasBackup: state.hasBackup,
        backupSavedAt: state.backupSavedAt,
      },
    };
  }
  if (state.document) {
    return {
      document: state.document,
      restoredFromAutosave: true,
      autosaveRecovery: null,
    };
  }
  return { document: fallback(), restoredFromAutosave: false, autosaveRecovery: null };
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
let lastToastSignature = "";
let lastToastAt = 0;

function makeToast(kind: ToastKind, text: string, action?: ToastAction): ToastMessage {
  toastSeq += 1;
  return { id: toastSeq, kind, text, ...(action ? { action } : {}) };
}

const TOOL_IDS = new Set<ToolId>(["pan", "elevation", "river", "biome", "places"]);

function findSettlementEntry(
  document: WorldDocument,
  layers: WorldLayers | null,
  id: string,
): Settlement | null {
  const fromLayers = layers?.settlements?.find((entry) => entry.id === id);
  if (fromLayers) return fromLayers;
  return (document.settlements ?? []).find((entry) => entry.id === id) ?? null;
}

function findLabelEntry(
  document: WorldDocument,
  layers: WorldLayers | null,
  id: string,
): MapLabel | null {
  const fromLayers = layers?.autoLabels?.find((entry) => entry.id === id);
  if (fromLayers) return fromLayers;
  return (document.labels ?? []).find((entry) => entry.id === id) ?? null;
}

function findPlaceName(
  document: WorldDocument,
  layers: WorldLayers | null,
  id: string,
): string {
  const collections = collectPlaces(document, layers);
  const entry = [...collections.visible, ...collections.hidden].find((place) => place.id === id);
  return entry?.name ?? "条目";
}

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
      kind: "full",
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
    selectedPlace: null,
    placeTool: {
      mode: "settlement",
      settlementKind: "city",
      labelKind: "region",
      name: "",
      armed: false,
    },
    placeRename: null,
    toast: null,
    climateOverlay: false,
    scenarioId: (() => {
      const stored = readStoredString(UI_PREF_KEYS.scenarioId, "");
      if (stored && SCENARIOS.some((scenario) => scenario.id === stored)) return stored;
      return findClosestScenarioId(initial.document.params);
    })(),
    locks: (() => {
      try {
        const raw = readStoredString(UI_PREF_KEYS.locks, "");
        if (!raw) return { ...DEFAULT_LOCKS };
        const parsed = JSON.parse(raw) as Partial<LockState>;
        const locks = { ...DEFAULT_LOCKS };
        for (const key of LOCK_KEYS) {
          if (typeof parsed[key] === "boolean") locks[key] = parsed[key] as boolean;
        }
        return locks;
      } catch {
        return { ...DEFAULT_LOCKS };
      }
    })(),
    generationHistory: [],
    historyPending: false,
    suppressNextHistoryPush: false,
    draftActive: false,
    draftRequests: 0,
    draftResults: 0,
    draftLayers: null,
    draftDocument: null,
    readability: null,
    readabilityDismissed: false,
    readabilityPending: false,
    requestSizeOverride: null,
    cancelTick: 0,
    simKind: "full",
    exportSize: (() => {
      const stored = Number(readStoredString(UI_PREF_KEYS.exportSize, "2048"));
      return stored === 1024 || stored === 2048 || stored === 4096 || stored === 8192
        ? stored
        : 2048;
    })(),
    perf: { hitTestMs: null, hitTestAt: null, lastGenerationMs: null, lastRenderMs: null },
    hitBoxes: null,
    hitBoxesSource: null,
    autosaveRecovery: initial.autosaveRecovery,

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
      if (options.sim) {
        if (options.draft) get().requestDraftGeneration();
        else get().requestGeneration(options.sim);
      }
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
          draft: options.draft === true,
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
        toast:
          readAlgorithm(document).kind === "classic"
            ? makeToast(
                "info",
                "此世界使用经典算法，已保持原貌；新建世界使用板块算法",
              )
            : makeToast("success", `已导入世界「${document.name || "未命名"}」`),
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
      const state = get();
      const patch: Partial<WorldStore> = { tool };
      if (tool !== "river" && state.riverDraft.points.length > 0) {
        patch.riverDraft = { active: false, points: [] };
      }
      if (tool !== "places") {
        patch.selectedPlace = null;
        patch.placeRename = null;
        patch.placeTool = { ...state.placeTool, armed: false };
      }
      set(patch);
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

    // ── places / labels editing ────────────────────────────────────────
    selectPlace: (selection) => {
      set({ selectedPlace: selection, placeRename: null });
    },

    setPlaceMode: (mode) => {
      set((state) => ({
        placeTool: { ...state.placeTool, mode, armed: false },
        placeRename: null,
      }));
    },

    setPlaceSettlementKind: (kind) => {
      set((state) => ({
        placeTool: { ...state.placeTool, settlementKind: kind, armed: false },
      }));
    },

    setPlaceLabelKind: (kind) => {
      set((state) => ({ placeTool: { ...state.placeTool, labelKind: kind, armed: false } }));
    },

    setPlaceName: (name) => {
      set((state) => ({
        placeTool: { ...state.placeTool, name: name.slice(0, MAX_NAME_LENGTH) },
      }));
    },

    togglePlaceArmed: () => {
      set((state) => ({ placeTool: { ...state.placeTool, armed: !state.placeTool.armed } }));
      if (get().placeTool.armed) {
        get().pushToast("info", "点击地图任意位置放置；Esc 取消");
      }
    },

    disarmPlacement: () => {
      set((state) => ({ placeTool: { ...state.placeTool, armed: false } }));
    },

    beginPlaceRename: (id, entity) => {
      set({ selectedPlace: { id, entity }, placeRename: { id, entity } });
    },

    cancelPlaceRename: () => {
      set({ placeRename: null });
    },

    renamePlace: (id, entity, name) => {
      const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
      if (trimmed.length === 0) {
        get().pushToast("error", "名称不能为空");
        return;
      }
      const { document, layers } = get();
      if (entity === "settlement") {
        const base = findSettlementEntry(document, layers, id);
        if (!base) {
          get().pushToast("error", "找不到该地点（可能已被删除）");
          return;
        }
        const next: Settlement = { ...base, name: trimmed, pinned: true };
        get().commitDocument(
          { ...document, settlements: upsertSettlement(document.settlements ?? [], next) },
          { history: "push", sim: "now" },
        );
      } else {
        const base = findLabelEntry(document, layers, id);
        if (!base) {
          get().pushToast("error", "找不到该地名（可能已被删除）");
          return;
        }
        const next: MapLabel = { ...base, text: trimmed, pinned: true };
        get().commitDocument(
          { ...document, labels: upsertLabel(document.labels ?? [], next) },
          { history: "push", sim: "now" },
        );
      }
      set({ placeRename: null, selectedPlace: { id, entity } });
      get().pushToast("info", `已重命名为「${trimmed}」`);
    },

    movePlace: (id, entity, x, y) => {
      const { document, layers } = get();
      const px = clamp01(x);
      const py = clamp01(y);
      if (entity === "settlement") {
        const base = findSettlementEntry(document, layers, id);
        if (!base) return;
        const next: Settlement = { ...base, x: px, y: py, pinned: true };
        get().commitDocument(
          { ...document, settlements: upsertSettlement(document.settlements ?? [], next) },
          { history: "push", sim: "now" },
        );
      } else {
        const base = findLabelEntry(document, layers, id);
        if (!base) return;
        const next: MapLabel = { ...base, x: px, y: py, pinned: true };
        get().commitDocument(
          { ...document, labels: upsertLabel(document.labels ?? [], next) },
          { history: "push", sim: "now" },
        );
      }
      set({ selectedPlace: { id, entity } });
    },

    hidePlace: (id) => {
      const { document, layers } = get();
      const hiddenIds = document.overrides.hiddenIds ?? [];
      if (hiddenIds.includes(id)) return;
      const name = findPlaceName(document, layers, id);
      get().commitDocument(
        {
          ...document,
          overrides: { ...document.overrides, hiddenIds: [...hiddenIds, id] },
        },
        { history: "push", sim: "now" },
      );
      set({ selectedPlace: null, placeRename: null });
      get().pushToast("info", `已隐藏「${name}」，可在「隐藏与恢复」中找回`);
    },

    restorePlace: (id) => {
      const { document, layers } = get();
      const hiddenIds = document.overrides.hiddenIds ?? [];
      if (!hiddenIds.includes(id)) return;
      const name = findPlaceName(document, layers, id);
      get().commitDocument(
        {
          ...document,
          overrides: {
            ...document.overrides,
            hiddenIds: hiddenIds.filter((entry) => entry !== id),
          },
        },
        { history: "push", sim: "now" },
      );
      get().pushToast("success", `已恢复「${name}」`);
    },

    deletePlace: (id, entity) => {
      const { document, layers } = get();
      const collections = collectPlaces(document, layers);
      const entry = [...collections.visible, ...collections.hidden].find(
        (place) => place.id === id && place.entity === entity,
      );
      const userAdded =
        entry?.userAdded ?? isUserPlaceId(entity, id);
      if (!userAdded) {
        get().pushToast("error", "只有用户新增的地点/标注可以彻底删除；生成条目请使用隐藏");
        return;
      }
      const hiddenIds = (document.overrides.hiddenIds ?? []).filter((entryId) => entryId !== id);
      const overrides = { ...document.overrides, hiddenIds };
      const next: WorldDocument =
        entity === "settlement"
          ? {
              ...document,
              settlements: (document.settlements ?? []).filter((place) => place.id !== id),
              overrides,
            }
          : {
              ...document,
              labels: (document.labels ?? []).filter((place) => place.id !== id),
              overrides,
            };
      get().commitDocument(next, { history: "push", sim: "now" });
      set({ selectedPlace: null, placeRename: null });
      get().pushToast("info", entry ? `已删除「${entry.name}」` : "已删除条目");
    },

    addPlaceAt: (x, y) => {
      const { document, layers, placeTool } = get();
      const px = clamp01(x);
      const py = clamp01(y);
      const existingNames = collectPlaceNames(collectPlaces(document, layers));
      if (placeTool.mode === "settlement") {
        const kind = placeTool.settlementKind;
        const baseName = placeTool.name.trim() || generatePlaceName("settlement", kind);
        const name = uniquePlaceName(baseName, existingNames);
        const entry = createUserSettlement(px, py, kind, name);
        get().commitDocument(
          {
            ...document,
            settlements: upsertSettlement(document.settlements ?? [], entry),
          },
          { history: "push", sim: "now" },
        );
        set({
          selectedPlace: { id: entry.id, entity: "settlement" },
          placeTool: { ...placeTool, armed: false, name: "" },
        });
        get().pushToast("success", `已添加地点「${entry.name}」：拖动定位，双击改名`);
      } else {
        const kind = placeTool.labelKind;
        const baseName = placeTool.name.trim() || generatePlaceName("label", kind);
        const name = uniquePlaceName(baseName, existingNames);
        const entry = createUserLabel(px, py, kind, name);
        get().commitDocument(
          { ...document, labels: upsertLabel(document.labels ?? [], entry) },
          { history: "push", sim: "now" },
        );
        set({
          selectedPlace: { id: entry.id, entity: "label" },
          placeTool: { ...placeTool, armed: false, name: "" },
        });
        get().pushToast("success", `已添加标注「${entry.text}」：拖动定位，双击改名`);
      }
    },

    // ── v0.5 diagnostics / algorithm ───────────────────────────────────
    setClimateOverlay: (enabled) => {
      set({ climateOverlay: enabled });
    },

    upgradeAlgorithm: () => {
      const { document } = get();
      if (readAlgorithm(document).kind === "plates") {
        get().pushToast("info", "当前世界已经是板块算法");
        return;
      }
      get().commitDocument(withPlatesAlgorithm(document), {
        history: "push",
        sim: "now",
        render: true,
      });
      get().pushToast("success", "已升级为板块算法；外观会变化，可撤销回经典算法");
    },

    // ── generation experience (v0.4) ───────────────────────────────────
    applyScenario: (scenarioId, options = {}) => {
      const scenario = scenarioById(scenarioId);
      const { document } = get();
      const seed =
        options.seed ??
        (scenario.seedStrategy === "fixed-salt" && typeof scenario.fixedSalt === "number"
          ? scenario.fixedSalt
          : Math.floor(Math.random() * 1_000_000_000));
      const next = createDefaultDocument({
        name: document.name,
        seed,
        params: {
          ...DEFAULT_PARAMS,
          ...scenario.params,
          gridSize: document.params.gridSize,
          namingLanguage: document.params.namingLanguage,
        },
        style: { ...DEFAULT_STYLE, ...scenario.style, title: document.name },
      });
      set({ scenarioId: scenario.id });
      writeStoredString(UI_PREF_KEYS.scenarioId, scenario.id);
      get().commitDocument(next, { history: "push", sim: "now", render: true });
      get().pushToast("success", `已应用场景「${scenario.name}」`);
    },

    setLock: (key, locked) => {
      set((state) => {
        const locks = { ...state.locks, [key]: locked };
        writeStoredString(UI_PREF_KEYS.locks, JSON.stringify(locks));
        return { locks };
      });
    },

    rerollUnlocked: () => {
      const { document, locks } = get();
      const seeds = explicitStageSeeds(document);
      let style = document.style;
      const changed: string[] = [];
      const kept: string[] = [];
      const stageByLock: { key: LockKey; stage: "terrain" | "climate" | "hydrology" | "human"; label: string }[] = [
        { key: "coast", stage: "terrain", label: "海岸" },
        { key: "climate", stage: "climate", label: "生态" },
        { key: "hydrology", stage: "hydrology", label: "河流" },
        { key: "human", stage: "human", label: "地名" },
      ];
      for (const item of stageByLock) {
        if (locks[item.key]) {
          // Keep the stage exactly as-is (explicit seed, or absent => seed fallback).
          kept.push(item.label);
          continue;
        }
        seeds[item.stage] = randomStageSeed();
        changed.push(item.label);
      }
      if (locks.style) {
        kept.push("风格");
      } else {
        style = {
          ...style,
          preset: style.preset === "parchment-classic" ? "aged-ink" : "parchment-classic",
        };
        changed.push("风格");
      }
      if (changed.length === 0) {
        get().pushToast("info", "所有阶段都已锁定，没有可更换的内容");
        return;
      }
      const next = withStageSeeds({ ...document, style }, seeds);
      get().commitDocument(next, { history: "push", sim: "now", render: true });
      get().pushToast(
        "info",
        changed.length > 0 ? describeLockToast(locks) : "所有阶段都已锁定，没有可更换的内容",
      );
    },

    rerollNames: () => {
      const { document } = get();
      const seeds = explicitStageSeeds(document);
      seeds.human = randomStageSeed();
      get().commitDocument(withStageSeeds(document, seeds), { history: "push", sim: "now" });
      get().pushToast("info", "已换一批地名；地形与河流保持不变");
    },

    setHistoryPending: (pending) => {
      set({ historyPending: pending });
    },

    pushGenerationHistory: (entry) => {
      set((state) => {
        const previous = state.generationHistory;
        const duplicate =
          previous.length > 0 &&
          previous[0].document.seed === entry.document.seed &&
          previous[0].document.updatedAt === entry.document.updatedAt;
        if (duplicate) return {};
        return {
          generationHistory: [entry, ...previous].slice(0, MAX_GENERATION_HISTORY),
        };
      });
    },

    restoreGenerationHistory: (id) => {
      const { generationHistory, document, scenarioId, baseCanvas } = get();
      const entry = generationHistory.find((item) => item.id === id);
      if (!entry) return;
      const currentEntry: GenerationHistoryEntry = {
        id: `gen-${Date.now().toString(36)}-${generationHistory.length}`,
        document: cloneDocumentForHistory(document),
        scenarioId,
        thumbnail: createThumbnail(baseCanvas),
        createdAt: Date.now(),
      };
      set((state) => ({
        generationHistory: [currentEntry, ...state.generationHistory].slice(
          0,
          MAX_GENERATION_HISTORY,
        ),
        suppressNextHistoryPush: true,
        scenarioId: entry.scenarioId,
      }));
      writeStoredString(UI_PREF_KEYS.scenarioId, entry.scenarioId);
      get().importDocument(entry.document);
      get().pushToast(
        "success",
        `已恢复历史世界 #${seedLabel(entry.document.seed).slice(1)}`,
      );
    },

    setReadability: (report) => {
      set({ readability: report, readabilityDismissed: report ? false : true });
    },

    dismissReadability: () => {
      set({ readabilityDismissed: true });
    },

    setReadabilityPending: (pending) => {
      set({ readabilityPending: pending });
    },

    // ── polish: export size / perf / hit boxes / autosave recovery ────
    setExportSize: (size) => {
      const allowed = [1024, 2048, 4096, 8192];
      const next = allowed.includes(size) ? size : 2048;
      writeStoredString(UI_PREF_KEYS.exportSize, String(next));
      set({ exportSize: next });
    },

    recordHitTest: (ms) => {
      const now = Date.now();
      set((state) => {
        if (state.perf.hitTestAt !== null && now - state.perf.hitTestAt < 150) return {};
        return { perf: { ...state.perf, hitTestMs: ms, hitTestAt: now } };
      });
    },

    setHitBoxes: (boxes, source) => {
      set({ hitBoxes: boxes, hitBoxesSource: source });
    },

    dismissAutosaveRecovery: () => {
      set({ autosaveRecovery: null });
    },

    recoverAutosave: () => {
      const backup = loadAutosaveBackup();
      if (!backup) {
        get().dismissAutosaveRecovery();
        get().pushToast("error", "没有可恢复的上一份自动存档");
        return;
      }
      get().importDocument(backup.document);
      set({ autosaveRecovery: null });
      // Drop the corrupt main payload first so the recovered write does not
      // copy it into the backup slot.
      clearAutosave(true);
      const result = saveAutosave(backup.document);
      if (result.ok) get().markSaved(result.savedAt);
      get().pushToast("success", "已恢复上一份自动存档");
    },

    clearCorruptedAutosave: () => {
      clearAutosave(true);
      set({ autosaveRecovery: null });
      get().pushToast("info", "已清空损坏的自动存档，将继续使用当前世界");
    },

    // ── generation lifecycle ───────────────────────────────────────────
    requestGeneration: (mode) => {
      set((state) => ({ simTick: state.simTick + 1, simMode: mode, simKind: "full" }));
    },

    requestDraftGeneration: () => {
      set((state) => ({
        simTick: state.simTick + 1,
        simMode: "debounce",
        simKind: "draft",
      }));
    },

    requestQuickGeneration: () => {
      set({
        requestSizeOverride: 512,
        simTick: get().simTick + 1,
        simMode: "now",
        simKind: "full",
      });
      get().pushToast("info", "快速模式：先用 512² 预览，满意后再全量生成");
    },

    requestCancelGeneration: () => {
      set((state) => ({ cancelTick: state.cancelTick + 1 }));
    },

    markGenerationCancelled: (seq) => {
      set((state) => {
        if (state.generation.phase !== "generating" && state.generation.phase !== "queued") {
          return {};
        }
        return {
          generation: {
            ...state.generation,
            kind: "full",
            phase: "idle",
            seq,
            progress: null,
            queuedLatest: false,
            finishedAt: Date.now(),
          },
          draftActive: false,
          draftLayers: null,
          draftDocument: null,
          suppressNextHistoryPush: false,
        };
      });
      get().pushToast("info", "已取消生成，保留上一张地图");
    },

    noteDraftRequest: () => {
      set((state) => ({ draftRequests: state.draftRequests + 1 }));
    },

    setDraftResult: (seq, layers, document) => {
      set((state) => {
        if (seq < state.lastAppliedSeq) return {};
        return {
          draftActive: true,
          draftResults: state.draftResults + 1,
          draftLayers: layers,
          draftDocument: document,
          generation: {
            ...state.generation,
            phase: "idle",
            kind: "draft",
            seq,
            progress: null,
            error: null,
            finishedAt: Date.now(),
          },
          renderTick: state.renderTick + 1,
        };
      });
    },

    consumeRequestSizeOverride: () => {
      const size = get().requestSizeOverride;
      if (size !== null) set({ requestSizeOverride: null });
      return size;
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

    generationStarted: (seq, kind: GenerationKind = "full") => {
      set({
        generation: {
          phase: "generating",
          kind,
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
          draftActive: false,
          draftLayers: null,
          draftDocument: null,
          readabilityPending: true,
          historyPending: state.suppressNextHistoryPush ? false : true,
          suppressNextHistoryPush: false,
          generation: {
            phase: "idle",
            kind: "full",
            seq,
            progress: null,
            error: null,
            startedAt,
            finishedAt: now,
            durationMs: startedAt ? now - startedAt : layers.stats.totalMs,
            queuedLatest: false,
          },
          perf: {
            ...state.perf,
            lastGenerationMs: startedAt ? now - startedAt : layers.stats.totalMs,
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
          draftActive: false,
          draftLayers: null,
          draftDocument: null,
          suppressNextHistoryPush: false,
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
        perf: { ...state.perf, lastRenderMs: elapsedMs },
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
      get().pushToast("error", message, { kind: "export-json", label: "立即导出备份" });
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

    pushToast: (kind, text, action) => {
      const signature = `${kind}:${text}`;
      const now = Date.now();
      if (signature === lastToastSignature && now - lastToastAt < 1200) return;
      lastToastSignature = signature;
      lastToastAt = now;
      set({ toast: makeToast(kind, text, action) });
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
