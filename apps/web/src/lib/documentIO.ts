/**
 * World document import / export / autosave.
 *
 * The world JSON is the single source of truth (see TODO.md §4). Imported or
 * restored documents are validated field by field and merged with the current
 * defaults so old / partial documents never crash the app.
 */
import {
  BIOME_NAMES,
  DEFAULT_PARAMS,
  DEFAULT_STYLE,
  createDefaultDocument,
  type BiomeId,
  type BiomeStamp,
  type ElevationMode,
  type ElevationStamp,
  type MapLabel,
  type RenderStyle,
  type RiverForcePath,
  type Settlement,
  type SettlementKind,
  type LabelKind,
  type WorldDocument,
  type WorldParams,
  type WorldOverrides,
} from "@atlas/core";

import {
  coreNormalizeWorldDocument,
  coreParseWorldDocumentJson,
  formatDocumentIssues,
  type DocumentIssue,
} from "./coreDocumentAdapter";
import {
  GRID_SIZE_OPTIONS,
  MAX_BIOME_STAMPS,
  MAX_ELEVATION_STAMPS,
  MAX_IMPORT_BYTES,
  MAX_NAME_LENGTH,
  MAX_RIVER_PATHS,
  MAX_RIVER_POINTS,
  PARAM_GROUPS,
  STORAGE_KEY,
  STYLE_PRESETS,
} from "./constants";
import { clamp, clamp01, downloadBlob, isFiniteNumber, isRecord, slugify, uid } from "./utils";

export type { DocumentIssue } from "./coreDocumentAdapter";

export class DocumentValidationError extends Error {
  readonly issues: DocumentIssue[];

  constructor(message: string, issues: DocumentIssue[] = []) {
    super(message);
    this.name = "DocumentValidationError";
    this.issues = issues;
  }
}

// ── Parameter / style normalization ───────────────────────────────────────

function normalizeParams(raw: unknown): WorldParams {
  const source = isRecord(raw) ? raw : {};
  const params: WorldParams = { ...DEFAULT_PARAMS };

  for (const slider of PARAM_GROUPS.flatMap((group) => group.sliders)) {
    const value = source[slider.key];
    if (isFiniteNumber(value)) {
      params[slider.key] = clamp(value, slider.min, slider.max);
    }
  }

  const gridValue = source.gridSize;
  if (isFiniteNumber(gridValue)) {
    const allowed = GRID_SIZE_OPTIONS.map((option) => option.value);
    const rounded = Math.round(gridValue);
    params.gridSize = allowed.includes(rounded)
      ? rounded
      : clamp(rounded, 256, 2048);
  }
  if (typeof source.windBands === "boolean") {
    params.windBands = source.windBands;
  }
  const namingLanguage = source.namingLanguage;
  params.namingLanguage =
    namingLanguage === "cjk" || namingLanguage === "latin" || namingLanguage === "auto"
      ? namingLanguage
      : "auto";
  return params;
}

function normalizeStyle(raw: unknown, fallbackTitle: string): RenderStyle {
  const source = isRecord(raw) ? raw : {};
  const style: RenderStyle = { ...DEFAULT_STYLE, title: fallbackTitle };
  if (source.preset === "parchment-classic" || source.preset === "aged-ink") {
    style.preset = source.preset;
  }
  if (typeof source.title === "string" && source.title.trim().length > 0) {
    style.title = source.title.trim().slice(0, MAX_NAME_LENGTH);
  }
  const toggleKeys = [
    "showLabels",
    "showRivers",
    "showGraticule",
    "showBorder",
    "showCompass",
    "showLegend",
  ] as const;
  for (const key of toggleKeys) {
    if (typeof source[key] === "boolean") style[key] = source[key] as boolean;
  }
  const sliderKeys = [
    "labelDensity",
    "paperTexture",
    "hillshadeStrength",
    "coastHatching",
  ] as const;
  for (const key of sliderKeys) {
    if (isFiniteNumber(source[key])) style[key] = clamp01(source[key] as number);
  }
  return style;
}

// ── Overrides normalization ───────────────────────────────────────────────

function normalizeElevationStamps(raw: unknown): ElevationStamp[] {
  if (!Array.isArray(raw)) return [];
  const stamps: ElevationStamp[] = [];
  for (const entry of raw.slice(0, MAX_ELEVATION_STAMPS)) {
    if (!isRecord(entry)) continue;
    const { x, y, radius, value, mode } = entry;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(radius)) continue;
    if (mode !== "raise" && mode !== "lower" && mode !== "lock") continue;
    const normalizedMode: ElevationMode = mode;
    let normalizedValue = isFiniteNumber(value) ? value : 0;
    normalizedValue =
      normalizedMode === "lock"
        ? clamp01(normalizedValue)
        : clamp(normalizedValue, -0.4, 0.4);
    stamps.push({
      x: clamp01(x),
      y: clamp01(y),
      radius: clamp(radius, 0.002, 0.35),
      value: normalizedValue,
      mode: normalizedMode,
    });
  }
  return stamps;
}

function normalizeBiomeStamps(raw: unknown): BiomeStamp[] {
  if (!Array.isArray(raw)) return [];
  const stamps: BiomeStamp[] = [];
  for (const entry of raw.slice(0, MAX_BIOME_STAMPS)) {
    if (!isRecord(entry)) continue;
    const { x, y, radius, biome } = entry;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(radius)) continue;
    if (!isFiniteNumber(biome) || !(biome in BIOME_NAMES)) continue;
    stamps.push({
      x: clamp01(x),
      y: clamp01(y),
      radius: clamp(radius, 0.002, 0.35),
      biome: biome as BiomeId,
    });
  }
  return stamps;
}

function normalizeRiverForce(raw: unknown): RiverForcePath[] {
  if (!Array.isArray(raw)) return [];
  const paths: RiverForcePath[] = [];
  for (const entry of raw.slice(0, MAX_RIVER_PATHS)) {
    if (!isRecord(entry)) continue;
    if (!Array.isArray(entry.points)) continue;
    const points: [number, number][] = [];
    for (const point of entry.points.slice(0, MAX_RIVER_POINTS)) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [px, py] = point;
      if (!isFiniteNumber(px) || !isFiniteNumber(py)) continue;
      points.push([clamp01(px), clamp01(py)]);
    }
    if (points.length < 2) continue;
    const width = isFiniteNumber(entry.width) ? clamp(entry.width, 0.0005, 0.2) : 0.006;
    paths.push({
      id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : uid("river"),
      points,
      width,
    });
  }
  return paths;
}

function normalizeHiddenIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string").slice(0, 500);
}

function normalizeOverrides(raw: unknown): WorldOverrides {
  const source = isRecord(raw) ? raw : {};
  return {
    elevation: normalizeElevationStamps(source.elevation),
    riverForce: normalizeRiverForce(source.riverForce),
    biome: normalizeBiomeStamps(source.biome),
    hiddenIds: normalizeHiddenIds(source.hiddenIds),
  };
}

const SETTLEMENT_KINDS: SettlementKind[] = ["city", "town", "port", "fortress", "ruin", "custom"];
const LABEL_KINDS: LabelKind[] = ["region", "water", "mountain", "custom"];

function normalizeSettlements(raw: unknown): Settlement[] {
  if (!Array.isArray(raw)) return [];
  const settlements: Settlement[] = [];
  for (const entry of raw.slice(0, 500)) {
    if (!isRecord(entry)) continue;
    const { id, name, kind, x, y, population, pinned } = entry;
    if (typeof name !== "string" || !isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    const normalizedKind = SETTLEMENT_KINDS.includes(kind as SettlementKind)
      ? (kind as SettlementKind)
      : "custom";
    settlements.push({
      id: typeof id === "string" && id.length > 0 ? id : uid("settlement"),
      name: name.slice(0, MAX_NAME_LENGTH),
      kind: normalizedKind,
      x: clamp01(x),
      y: clamp01(y),
      ...(isFiniteNumber(population) ? { population: Math.round(population) } : {}),
      ...(typeof pinned === "boolean" ? { pinned } : {}),
    });
  }
  return settlements;
}

function normalizeLabels(raw: unknown): MapLabel[] {
  if (!Array.isArray(raw)) return [];
  const labels: MapLabel[] = [];
  for (const entry of raw.slice(0, 1000)) {
    if (!isRecord(entry)) continue;
    const { id, text, kind, x, y, rotation, size, pinned } = entry;
    if (typeof text !== "string" || !isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    const normalizedKind = LABEL_KINDS.includes(kind as LabelKind)
      ? (kind as LabelKind)
      : "custom";
    labels.push({
      id: typeof id === "string" && id.length > 0 ? id : uid("label"),
      text: text.slice(0, MAX_NAME_LENGTH),
      kind: normalizedKind,
      x: clamp01(x),
      y: clamp01(y),
      ...(isFiniteNumber(rotation) ? { rotation } : {}),
      ...(isFiniteNumber(size) ? { size: clamp(size, 6, 96) } : {}),
      ...(typeof pinned === "boolean" ? { pinned } : {}),
    });
  }
  return labels;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Legacy (web-local) normalizer: validates a version-1 world and merges
 * defaults. Kept as a fallback while the core document API rolls out.
 */
function normalizeDocumentLegacy(raw: unknown): WorldDocument {
  if (!isRecord(raw)) {
    throw new DocumentValidationError("世界文件必须是一个 JSON 对象");
  }
  if (raw.version !== 1) {
    throw new DocumentValidationError(
      `世界文件版本不受支持：需要 version = 1，实际为 ${String(raw.version)}`,
    );
  }
  if (!isFiniteNumber(raw.seed)) {
    throw new DocumentValidationError("世界文件缺少有效的 seed（种子）");
  }
  if (!isRecord(raw.params)) {
    throw new DocumentValidationError("世界文件缺少 params（生成参数）");
  }

  const fallback = createDefaultDocument({ seed: Math.round(raw.seed) });
  const name =
    typeof raw.name === "string" && raw.name.trim().length > 0
      ? raw.name.trim().slice(0, MAX_NAME_LENGTH)
      : fallback.name;
  const now = new Date().toISOString();

  return {
    version: 1,
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : fallback.id,
    name,
    seed: Math.round(raw.seed),
    params: normalizeParams(raw.params),
    style: normalizeStyle(raw.style, name),
    overrides: normalizeOverrides(raw.overrides),
    settlements: normalizeSettlements(raw.settlements),
    labels: normalizeLabels(raw.labels),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

export interface DocumentParseResult {
  /** Null when the payload cannot be recovered at all (fatal parse error). */
  document: WorldDocument | null;
  issues: DocumentIssue[];
}

/**
 * Normalize an unknown value, preferring the core implementation when present.
 * Unlike the throwing wrapper below, this never throws: callers can inspect
 * `issues` and decide whether to reject or import with warnings.
 */
export function normalizeDocumentDetailed(raw: unknown): DocumentParseResult {
  const coreResult = coreNormalizeWorldDocument(raw);
  if (coreResult) {
    return { document: coreResult.document, issues: coreResult.issues };
  }
  try {
    return { document: normalizeDocumentLegacy(raw), issues: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { document: null, issues: [{ path: "", message, severity: "error" }] };
  }
}

/**
 * Validate an unknown JSON value and return a complete WorldDocument.
 * Throws DocumentValidationError with readable issues on fatal problems.
 */
export function normalizeDocument(raw: unknown): WorldDocument {
  const result = normalizeDocumentDetailed(raw);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (!result.document || errors.length > 0) {
    throw new DocumentValidationError(
      errors.length > 0 ? formatDocumentIssues(result.issues) : "世界文件无效",
      result.issues,
    );
  }
  return result.document;
}

export function parseWorldDocumentJsonDetailed(text: string): DocumentParseResult {
  const coreResult = coreParseWorldDocumentJson(text);
  if (coreResult) return { document: coreResult.document, issues: coreResult.issues };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      document: null,
      issues: [
        {
          path: "",
          message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
        },
      ],
    };
  }
  return normalizeDocumentDetailed(parsed);
}

export function parseWorldDocumentJson(text: string): WorldDocument {
  const result = parseWorldDocumentJsonDetailed(text);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (!result.document || errors.length > 0) {
    throw new DocumentValidationError(
      errors.length > 0 ? formatDocumentIssues(result.issues) : "世界文件无效",
      result.issues,
    );
  }
  return result.document;
}

/** Read + validate a user-selected JSON file without throwing on bad data. */
export async function readWorldDocumentFile(file: File): Promise<DocumentParseResult> {
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      document: null,
      issues: [
        {
          path: "",
          message: `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
          severity: "error",
        },
      ],
    };
  }
  const text = await file.text();
  return parseWorldDocumentJsonDetailed(text);
}

export function serializeDocument(document: WorldDocument): string {
  return JSON.stringify(document, null, 2);
}

export function exportDocumentJson(document: WorldDocument): string {
  const blob = new Blob([serializeDocument(document)], { type: "application/json" });
  const filename = `${slugify(document.name)}-${document.seed}.world.json`;
  downloadBlob(blob, filename);
  return filename;
}

// ── Autosave ──────────────────────────────────────────────────────────────

export const BACKUP_STORAGE_KEY = "atlas_forge.world.backup.v1";

interface AutosavePayload {
  version: 1;
  savedAt: number;
  document: WorldDocument;
}

export interface AutosaveResult {
  ok: boolean;
  savedAt: number;
  error?: string;
  /** Browser may reject even the backup write when storage quota is exhausted. */
  backupOk?: boolean;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseAutosavePayload(raw: string | null): { document: WorldDocument; savedAt: number } | null {
  if (!raw) return null;
  try {
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload) || payload.version !== 1) return null;
    const result = normalizeDocumentDetailed(payload.document);
    const errors = result.issues.filter((issue) => issue.severity === "error");
    if (!result.document || errors.length > 0) return null;
    const savedAt = typeof payload.savedAt === "number" && Number.isFinite(payload.savedAt)
      ? payload.savedAt
      : Date.now();
    return { document: result.document, savedAt };
  } catch {
    return null;
  }
}

/**
 * Persist the current document. The previous main payload is copied to the
 * backup key first so a corrupted write / manual recovery always has a
 * fallback snapshot.
 */
export function saveAutosave(document: WorldDocument): AutosaveResult {
  const savedAt = Date.now();
  let backupOk = true;
  try {
    const previous = readRaw(STORAGE_KEY);
    if (previous) localStorage.setItem(BACKUP_STORAGE_KEY, previous);
  } catch {
    backupOk = false;
  }
  try {
    const payload: AutosavePayload = { version: 1, savedAt, document };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return { ok: true, savedAt, backupOk };
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "QuotaExceededError"
        ? "浏览器本地存储已满，自动保存失败（可立即导出 JSON 备份）"
        : `自动保存失败：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, savedAt, error: message, backupOk };
  }
}

export interface AutosaveLoadState {
  document: WorldDocument | null;
  /** The main autosave exists but cannot be parsed/normalized. */
  corrupted: boolean;
  corruptedMessage: string | null;
  backupSavedAt: number | null;
  hasBackup: boolean;
}

/** Inspect main + backup autosave slots without overwriting anything. */
export function loadAutosaveState(): AutosaveLoadState {
  const mainRaw = readRaw(STORAGE_KEY);
  const backupRaw = readRaw(BACKUP_STORAGE_KEY);
  const backup = parseAutosavePayload(backupRaw);
  if (!mainRaw) {
    return {
      document: null,
      corrupted: false,
      corruptedMessage: null,
      backupSavedAt: backup?.savedAt ?? null,
      hasBackup: backup !== null,
    };
  }
  const main = parseAutosavePayload(mainRaw);
  if (main) {
    return {
      document: main.document,
      corrupted: false,
      corruptedMessage: null,
      backupSavedAt: backup?.savedAt ?? null,
      hasBackup: backup !== null,
    };
  }
  return {
    document: null,
    corrupted: true,
    corruptedMessage: "浏览器自动存档无法解析（可能写入中断或版本过旧）",
    backupSavedAt: backup?.savedAt ?? null,
    hasBackup: backup !== null,
  };
}

/** Returns the main autosave document when valid (compat helper). */
export function loadAutosave(): WorldDocument | null {
  return loadAutosaveState().document;
}

/** Load the previous good snapshot (used by the recovery panel). */
export function loadAutosaveBackup(): { document: WorldDocument; savedAt: number } | null {
  const backup = parseAutosavePayload(readRaw(BACKUP_STORAGE_KEY));
  return backup ? { document: backup.document, savedAt: backup.savedAt } : null;
}

export function clearAutosave(includeBackup = true): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  if (!includeBackup) return;
  try {
    localStorage.removeItem(BACKUP_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Editor helpers used by the UI ─────────────────────────────────────────

export function countOverrides(overrides: WorldOverrides): {
  elevation: number;
  rivers: number;
  riverPoints: number;
  biome: number;
  hidden: number;
  total: number;
} {
  const riverPoints = overrides.riverForce.reduce((sum, river) => sum + river.points.length, 0);
  return {
    elevation: overrides.elevation.length,
    rivers: overrides.riverForce.length,
    riverPoints,
    biome: overrides.biome.length,
    hidden: overrides.hiddenIds.length,
    total: overrides.elevation.length + overrides.riverForce.length + overrides.biome.length,
  };
}

export function stylePresetLabel(preset: RenderStyle["preset"]): string {
  return STYLE_PRESETS[preset]?.label ?? preset;
}

export function cloneDocumentForHistory(document: WorldDocument): WorldDocument {
  return JSON.parse(JSON.stringify(document)) as WorldDocument;
}
