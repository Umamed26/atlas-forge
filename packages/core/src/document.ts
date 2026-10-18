/**
 * World-document import / normalization layer.
 *
 * `WorldDocument` is the single source of truth of a world (TODO.md §4). Files
 * imported from disk, localStorage autosaves or third-party tools may be old,
 * partial or corrupted, so this module validates unknown JSON and always
 * returns a *complete, usable* `WorldDocument` plus a list of human-readable
 * issues (the UI decides whether an error is fatal).
 *
 * Invariants:
 *  - never throws for malformed input (non-objects, bad version, NaN seeds,
 *    invalid JSON strings all produce an `error` issue + a fallback document)
 *  - legacy documents with missing fields are merged with DEFAULT_PARAMS /
 *    DEFAULT_STYLE without warnings (missing != invalid)
 *  - output is idempotent: normalizing `normalizeWorldDocument(x).document`
 *    produces no new *error* issues and the same field values
 *  - pure and dependency-free; input is never mutated
 */
import { DEFAULT_PARAMS, DEFAULT_STYLE, createDefaultDocument } from "./defaults";
import { hashString } from "./rng";
import {
  BIOME_NAMES,
  type BiomeId,
  type BiomeStamp,
  type ElevationStamp,
  type LabelKind,
  type MapLabel,
  type RenderStyle,
  type RiverForcePath,
  type Settlement,
  type SettlementKind,
  type StageSeeds,
  type WorldDocument,
  type WorldOverrides,
  type WorldParams,
} from "./types";

// ── Public API ────────────────────────────────────────────────────────────

export interface DocumentIssue {
  /** JSON-path-like location, e.g. "params.seaLevel" or "settlements[2].kind". */
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface NormalizedDocument {
  document: WorldDocument;
  issues: DocumentIssue[];
}

// ── Limits (mirror the editor limits; core stays self-contained) ──────────

const MAX_NAME_LENGTH = 120;
const MAX_ELEVATION_STAMPS = 6000;
const MAX_BIOME_STAMPS = 6000;
const MAX_RIVER_PATHS = 80;
const MAX_RIVER_POINTS = 2000;
const MAX_SETTLEMENTS = 3000;
const MAX_LABELS = 5000;
const MAX_HIDDEN_IDS = 5000;
const MAX_ISSUES = 200;

const SETTLEMENT_KINDS: readonly SettlementKind[] = [
  "city",
  "town",
  "port",
  "fortress",
  "ruin",
  "custom",
];
const LABEL_KINDS: readonly LabelKind[] = ["region", "water", "mountain", "custom"];

// ── Small guards / issue helpers ──────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

class IssueCollector {
  readonly issues: DocumentIssue[] = [];
  private truncated = false;

  add(path: string, message: string, severity: DocumentIssue["severity"] = "warning"): void {
    if (this.issues.length >= MAX_ISSUES) {
      this.truncated = true;
      return;
    }
    this.issues.push({ path, message, severity });
  }

  error(path: string, message: string): void {
    this.add(path, message, "error");
  }

  /** Clamp a finite number, reporting only real changes. */
  clamp(
    value: number,
    min: number,
    max: number,
    path: string,
    label: string,
  ): number {
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) this.add(path, `${label} 超出范围，已限制为 ${clamped}`);
    return clamped;
  }

  finish(): DocumentIssue[] {
    if (this.truncated) {
      this.issues.push({
        path: "$",
        message: `问题过多，仅显示前 ${MAX_ISSUES} 条`,
        severity: "warning",
      });
    }
    return this.issues;
  }
}

function truncatedArray(
  length: number,
  limit: number,
  path: string,
  issues: IssueCollector,
): number {
  if (length <= limit) return length;
  issues.add(path, `条目过多，仅保留前 ${limit} 条`);
  return limit;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function generatedId(prefix: string, index: number, name: string, x: unknown, y: unknown): string {
  // Deterministic (no Math.random) so re-importing the same broken JSON yields
  // the same ids, and normalizing the output again is stable.
  const key = `${prefix}|${index}|${name}|${String(x)}|${String(y)}`;
  return `${prefix}-import-${hashString(key).toString(36)}`;
}

// ── Params ────────────────────────────────────────────────────────────────

interface NumberRange {
  min: number;
  max: number;
  label: string;
  integer?: boolean;
}

const PARAM_RANGES: Record<
  Exclude<keyof WorldParams, "gridSize" | "windBands" | "namingLanguage" | "stageSeeds" | "terrainModel" | "tectonicPlates">,
  NumberRange
> = {
  seaLevel: { min: 0.2, max: 0.7, label: "海平面" },
  // Presets may push continentScale up to the pipeline clamp (4.0) for fragmented archipelagos; import must not lower it.
  continentScale: { min: 0.25, max: 4, label: "大陆尺度" },
  continentality: { min: 0, max: 1, label: "大陆度" },
  warpStrength: { min: 0, max: 1, label: "海岸扭曲" },
  ridgeStrength: { min: 0, max: 1, label: "山脉强度" },
  ridgeScale: { min: 1, max: 4, label: "山脉尺度" },
  erosionIterations: { min: 0, max: 200, label: "侵蚀迭代", integer: true },
  riverDensity: { min: 0, max: 1, label: "河流密度" },
  windAngle: { min: 0, max: 360, label: "信风角度" },
  moistureBias: { min: -0.5, max: 0.5, label: "湿度偏差" },
  temperatureOffset: { min: -0.35, max: 0.35, label: "温度偏移" },
};

const STAGE_SEED_KEYS = ["terrain", "hydrology", "climate", "human"] as const;

function normalizeStageSeeds(raw: unknown, issues: IssueCollector): StageSeeds | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.add("params.stageSeeds", "阶段种子不是对象，已忽略");
    return undefined;
  }
  const seeds: StageSeeds = {};
  let hasValue = false;
  for (const key of STAGE_SEED_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isFiniteNumber(value)) {
      issues.add(`params.stageSeeds.${key}`, "阶段种子不是有效数字，已忽略");
      continue;
    }
    const rounded = Math.round(value);
    if (rounded !== value) {
      issues.add(`params.stageSeeds.${key}`, "阶段种子已取整");
    }
    seeds[key] = rounded;
    hasValue = true;
  }
  return hasValue ? seeds : undefined;
}

function normalizeParams(raw: unknown, issues: IssueCollector): WorldParams {
  const source = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) {
    issues.add("params", "生成参数不是对象，已回退为默认参数");
  }
  const params: WorldParams = { ...DEFAULT_PARAMS };

  for (const key of Object.keys(PARAM_RANGES) as (keyof typeof PARAM_RANGES)[]) {
    const range = PARAM_RANGES[key];
    const value = source[key];
    if (value === undefined) continue; // legacy document: keep default silently
    if (!isFiniteNumber(value)) {
      issues.add(`params.${key}`, `${range.label}不是有效数字，已使用默认值`);
      continue;
    }
    let normalized = range.integer ? Math.round(value) : value;
    if (key === "windAngle") {
      normalized = ((value % 360) + 360) % 360;
    }
    params[key] = issues.clamp(normalized, range.min, range.max, `params.${key}`, range.label);
  }

  const gridValue = source.gridSize;
  if (gridValue !== undefined) {
    if (!isFiniteNumber(gridValue)) {
      issues.add("params.gridSize", "网格尺寸不是有效数字，已使用默认值");
    } else {
      const rounded = Math.round(gridValue);
      if (rounded !== gridValue) issues.add("params.gridSize", "网格尺寸已取整");
      params.gridSize = issues.clamp(rounded, 256, 2048, "params.gridSize", "网格尺寸");
    }
  }

  if (source.windBands !== undefined) {
    if (typeof source.windBands === "boolean") {
      params.windBands = source.windBands;
    } else {
      issues.add("params.windBands", "风带开关不是布尔值，已使用默认值");
    }
  }

  if (source.namingLanguage !== undefined) {
    const value = source.namingLanguage;
    if (value === "auto" || value === "cjk" || value === "latin") {
      params.namingLanguage = value;
    } else {
      params.namingLanguage = "auto";
      issues.add("params.namingLanguage", "命名语言无效，已回退为 auto（按种子自动选择）");
    }
  }

  const stageSeeds = normalizeStageSeeds(source.stageSeeds, issues);
  if (stageSeeds) params.stageSeeds = stageSeeds;

  if (source.terrainModel !== undefined) {
    if (source.terrainModel === "plates" || source.terrainModel === "fbm") {
      params.terrainModel = source.terrainModel;
    } else {
      issues.add("params.terrainModel", "地形模型无效，已回退为默认值");
    }
  }

  if (source.tectonicPlates !== undefined) {
    if (isFiniteNumber(source.tectonicPlates)) {
      const rounded = Math.round(source.tectonicPlates);
      if (rounded !== source.tectonicPlates) issues.add("params.tectonicPlates", "板块数量已取整");
      params.tectonicPlates = issues.clamp(rounded, 4, 64, "params.tectonicPlates", "板块数量");
    } else {
      issues.add("params.tectonicPlates", "板块数量不是有效数字，已忽略");
    }
  }
  return params;
}

// ── Style ─────────────────────────────────────────────────────────────────

const STYLE_TOGGLES = [
  "showLabels",
  "showRivers",
  "showGraticule",
  "showBorder",
  "showCompass",
  "showLegend",
] as const;
const STYLE_SLIDERS = [
  "labelDensity",
  "paperTexture",
  "hillshadeStrength",
  "coastHatching",
] as const;

function normalizeStyle(raw: unknown, fallbackTitle: string, issues: IssueCollector): RenderStyle {
  const source = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) {
    issues.add("style", "样式不是对象，已回退为默认样式");
  }
  const style: RenderStyle = { ...DEFAULT_STYLE, title: fallbackTitle };

  if (source.preset !== undefined) {
    if (source.preset === "parchment-classic" || source.preset === "aged-ink") {
      style.preset = source.preset;
    } else {
      issues.add("style.preset", "样式预设无效，已回退为 parchment-classic");
    }
  }
  if (source.title !== undefined) {
    if (typeof source.title === "string" && source.title.trim().length > 0) {
      style.title = source.title.trim().slice(0, MAX_NAME_LENGTH);
    } else {
      issues.add("style.title", "标题无效，已回退为世界名");
    }
  }
  for (const key of STYLE_TOGGLES) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value === "boolean") style[key] = value;
    else issues.add(`style.${key}`, "显示开关不是布尔值，已使用默认值");
  }
  for (const key of STYLE_SLIDERS) {
    const value = source[key];
    if (value === undefined) continue;
    if (isFiniteNumber(value)) {
      style[key] = issues.clamp(clamp01(value), 0, 1, `style.${key}`, "样式数值");
    } else {
      issues.add(`style.${key}`, "样式数值无效，已使用默认值");
    }
  }
  return style;
}

// ── Entities: settlements / labels ────────────────────────────────────────

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeSettlements(raw: unknown, issues: IssueCollector): Settlement[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add("settlements", "settlements 不是数组，已忽略");
    return [];
  }
  const limit = truncatedArray(raw.length, MAX_SETTLEMENTS, "settlements", issues);
  const settlements: Settlement[] = [];
  for (let index = 0; index < limit; index += 1) {
    const entry = raw[index];
    const path = `settlements[${index}]`;
    if (!isRecord(entry)) {
      issues.add(path, "地点条目不是对象，已丢弃");
      continue;
    }
    const x = entry.x;
    const y = entry.y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      issues.add(path, "地点坐标无效，已丢弃");
      continue;
    }
    const name = normalizeText(entry.name, MAX_NAME_LENGTH);
    if (name === null) {
      issues.add(path, "地点名称为空或类型错误，已丢弃");
      continue;
    }
    const kind = SETTLEMENT_KINDS.includes(entry.kind as SettlementKind)
      ? (entry.kind as SettlementKind)
      : "custom";
    if (entry.kind !== undefined && kind !== entry.kind) {
      issues.add(`${path}.kind`, "地点类型无效，已回退为 custom");
    }
    let id = "";
    if (typeof entry.id === "string" && entry.id.trim().length > 0) {
      id = entry.id;
    } else {
      id = generatedId("st", index, name, x, y);
      if (entry.id !== undefined) issues.add(`${path}.id`, "地点 id 无效，已生成新 id");
    }
    const settlement: Settlement = {
      id,
      name,
      kind,
      x: issues.clamp(x, 0, 1, `${path}.x`, "坐标"),
      y: issues.clamp(y, 0, 1, `${path}.y`, "坐标"),
    };
    if (entry.population !== undefined) {
      if (isFiniteNumber(entry.population)) {
        settlement.population = Math.max(0, Math.round(entry.population));
      } else {
        issues.add(`${path}.population`, "人口不是有效数字，已忽略");
      }
    }
    if (entry.pinned !== undefined) {
      const pinned = coerceBoolean(entry.pinned);
      if (pinned === undefined) issues.add(`${path}.pinned`, "pinned 不是布尔值，已忽略");
      else settlement.pinned = pinned;
    }
    settlements.push(settlement);
  }
  return settlements;
}

function normalizeLabels(raw: unknown, issues: IssueCollector): MapLabel[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add("labels", "labels 不是数组，已忽略");
    return [];
  }
  const limit = truncatedArray(raw.length, MAX_LABELS, "labels", issues);
  const labels: MapLabel[] = [];
  for (let index = 0; index < limit; index += 1) {
    const entry = raw[index];
    const path = `labels[${index}]`;
    if (!isRecord(entry)) {
      issues.add(path, "地名条目不是对象，已丢弃");
      continue;
    }
    const x = entry.x;
    const y = entry.y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      issues.add(path, "地名坐标无效，已丢弃");
      continue;
    }
    const text = normalizeText(entry.text, MAX_NAME_LENGTH);
    if (text === null) {
      issues.add(path, "地名文本为空或类型错误，已丢弃");
      continue;
    }
    const kind = LABEL_KINDS.includes(entry.kind as LabelKind)
      ? (entry.kind as LabelKind)
      : "custom";
    if (entry.kind !== undefined && kind !== entry.kind) {
      issues.add(`${path}.kind`, "地名类型无效，已回退为 custom");
    }
    let id = "";
    if (typeof entry.id === "string" && entry.id.trim().length > 0) {
      id = entry.id;
    } else {
      id = generatedId("lbl", index, text, x, y);
      if (entry.id !== undefined) issues.add(`${path}.id`, "地名 id 无效，已生成新 id");
    }
    const label: MapLabel = {
      id,
      text,
      kind,
      x: issues.clamp(x, 0, 1, `${path}.x`, "坐标"),
      y: issues.clamp(y, 0, 1, `${path}.y`, "坐标"),
    };
    if (entry.rotation !== undefined) {
      if (isFiniteNumber(entry.rotation)) label.rotation = entry.rotation;
      else issues.add(`${path}.rotation`, "旋转角不是有效数字，已忽略");
    }
    if (entry.size !== undefined) {
      if (isFiniteNumber(entry.size)) {
        label.size = issues.clamp(entry.size, 6, 96, `${path}.size`, "字号");
      } else {
        issues.add(`${path}.size`, "字号不是有效数字，已忽略");
      }
    }
    if (entry.pinned !== undefined) {
      const pinned = coerceBoolean(entry.pinned);
      if (pinned === undefined) issues.add(`${path}.pinned`, "pinned 不是布尔值，已忽略");
      else label.pinned = pinned;
    }
    labels.push(label);
  }
  return labels;
}

// ── Overrides ─────────────────────────────────────────────────────────────

function normalizeElevationStamps(raw: unknown, issues: IssueCollector): ElevationStamp[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add("overrides.elevation", "海拔笔刷不是数组，已忽略");
    return [];
  }
  const limit = truncatedArray(raw.length, MAX_ELEVATION_STAMPS, "overrides.elevation", issues);
  const stamps: ElevationStamp[] = [];
  for (let index = 0; index < limit; index += 1) {
    const entry = raw[index];
    const path = `overrides.elevation[${index}]`;
    if (!isRecord(entry)) {
      issues.add(path, "海拔笔刷条目不是对象，已丢弃");
      continue;
    }
    const mode = entry.mode;
    if (mode !== "lock" && mode !== "raise" && mode !== "lower") {
      issues.add(`${path}.mode`, "海拔笔刷模式无效，已丢弃");
      continue;
    }
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y) || !isFiniteNumber(entry.radius)) {
      issues.add(path, "海拔笔刷坐标或半径无效，已丢弃");
      continue;
    }
    let value = 0;
    if (isFiniteNumber(entry.value)) {
      value = mode === "lock" ? clamp01(entry.value) : Math.min(0.4, Math.max(-0.4, entry.value));
    } else if (entry.value !== undefined) {
      issues.add(`${path}.value`, "海拔笔刷数值无效，已使用 0");
    }
    stamps.push({
      x: issues.clamp(entry.x, 0, 1, `${path}.x`, "坐标"),
      y: issues.clamp(entry.y, 0, 1, `${path}.y`, "坐标"),
      radius: issues.clamp(entry.radius, 0.002, 0.35, `${path}.radius`, "半径"),
      value,
      mode,
    });
  }
  return stamps;
}

function normalizeBiomeStamps(raw: unknown, issues: IssueCollector): BiomeStamp[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add("overrides.biome", "群系笔刷不是数组，已忽略");
    return [];
  }
  const limit = truncatedArray(raw.length, MAX_BIOME_STAMPS, "overrides.biome", issues);
  const stamps: BiomeStamp[] = [];
  for (let index = 0; index < limit; index += 1) {
    const entry = raw[index];
    const path = `overrides.biome[${index}]`;
    if (!isRecord(entry)) {
      issues.add(path, "群系笔刷条目不是对象，已丢弃");
      continue;
    }
    const biome = entry.biome;
    if (
      !isFiniteNumber(biome) ||
      !Number.isInteger(biome) ||
      !(biome.toString() in BIOME_NAMES)
    ) {
      issues.add(`${path}.biome`, "群系 id 无效，已丢弃");
      continue;
    }
    if (!isFiniteNumber(entry.x) || !isFiniteNumber(entry.y) || !isFiniteNumber(entry.radius)) {
      issues.add(path, "群系笔刷坐标或半径无效，已丢弃");
      continue;
    }
    stamps.push({
      x: issues.clamp(entry.x, 0, 1, `${path}.x`, "坐标"),
      y: issues.clamp(entry.y, 0, 1, `${path}.y`, "坐标"),
      radius: issues.clamp(entry.radius, 0.002, 0.35, `${path}.radius`, "半径"),
      biome: biome as BiomeId,
    });
  }
  return stamps;
}

function normalizeRiverForce(raw: unknown, issues: IssueCollector): RiverForcePath[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add("overrides.riverForce", "强制河道不是数组，已忽略");
    return [];
  }
  const limit = truncatedArray(raw.length, MAX_RIVER_PATHS, "overrides.riverForce", issues);
  const paths: RiverForcePath[] = [];
  for (let index = 0; index < limit; index += 1) {
    const entry = raw[index];
    const path = `overrides.riverForce[${index}]`;
    if (!isRecord(entry) || !Array.isArray(entry.points)) {
      issues.add(path, "强制河道条目无效，已丢弃");
      continue;
    }
    const pointLimit = truncatedArray(entry.points.length, MAX_RIVER_POINTS, `${path}.points`, issues);
    const points: [number, number][] = [];
    for (let pointIndex = 0; pointIndex < pointLimit; pointIndex += 1) {
      const point = entry.points[pointIndex];
      if (!Array.isArray(point) || point.length < 2) {
        issues.add(`${path}.points[${pointIndex}]`, "河道点格式无效，已丢弃");
        continue;
      }
      const px = point[0];
      const py = point[1];
      if (!isFiniteNumber(px) || !isFiniteNumber(py)) {
        issues.add(`${path}.points[${pointIndex}]`, "河道点坐标无效，已丢弃");
        continue;
      }
      points.push([
        issues.clamp(px, 0, 1, `${path}.points[${pointIndex}].x`, "坐标"),
        issues.clamp(py, 0, 1, `${path}.points[${pointIndex}].y`, "坐标"),
      ]);
    }
    if (points.length < 2) {
      issues.add(path, "强制河道有效点不足 2 个，已丢弃");
      continue;
    }
    let id = "";
    if (typeof entry.id === "string" && entry.id.trim().length > 0) {
      id = entry.id;
    } else {
      id = generatedId("river", index, "", points[0][0], points[0][1]);
      if (entry.id !== undefined) issues.add(`${path}.id`, "河道 id 无效，已生成新 id");
    }
    const width = isFiniteNumber(entry.width)
      ? issues.clamp(entry.width, 0.0005, 0.2, `${path}.width`, "河宽")
      : 0.006;
    paths.push({ id, points, width });
  }
  return paths;
}

function normalizeHiddenIds(raw: unknown, issues: IssueCollector): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add("overrides.hiddenIds", "hiddenIds 不是数组，已忽略");
    return [];
  }
  const limit = truncatedArray(raw.length, MAX_HIDDEN_IDS, "overrides.hiddenIds", issues);
  const seen = new Set<string>();
  const hiddenIds: string[] = [];
  let dropped = 0;
  for (let index = 0; index < limit; index += 1) {
    const id = raw[index];
    if (typeof id !== "string" || id.length === 0) {
      dropped += 1;
      continue;
    }
    if (seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    hiddenIds.push(id);
  }
  if (dropped > 0) {
    issues.add("overrides.hiddenIds", `已移除 ${dropped} 个无效或重复的隐藏 id`);
  }
  return hiddenIds;
}

function normalizeOverrides(raw: unknown, issues: IssueCollector): WorldOverrides {
  const source = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) {
    issues.add("overrides", "编辑覆盖层不是对象，已回退为空");
  }
  return {
    elevation: normalizeElevationStamps(source.elevation, issues),
    riverForce: normalizeRiverForce(source.riverForce, issues),
    biome: normalizeBiomeStamps(source.biome, issues),
    hiddenIds: normalizeHiddenIds(source.hiddenIds, issues),
  };
}

// ── Timestamps ────────────────────────────────────────────────────────────

function normalizeTimestamp(raw: unknown, now: string): string {
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return now;
}

// ── Entry points ──────────────────────────────────────────────────────────

function fallbackDocument(issues: IssueCollector, message: string): WorldDocument {
  issues.error("$", message);
  return createDefaultDocument();
}

/**
 * Validate an unknown value and return a complete `WorldDocument` plus issues.
 * Never throws; a fatal problem yields an `error`-severity issue and a usable
 * fallback document (the UI decides whether to accept it).
 */
export function normalizeWorldDocument(input: unknown): NormalizedDocument {
  const issues = new IssueCollector();
  try {
    if (!isRecord(input)) {
      return { document: fallbackDocument(issues, "世界文件必须是一个 JSON 对象"), issues: issues.finish() };
    }

    const now = new Date().toISOString();
    if (input.version !== 1) {
      issues.error(
        "version",
        `世界文件版本不受支持：需要 version = 1，实际为 ${String(input.version)}`,
      );
    }
    const seed = input.seed;
    if (!isFiniteNumber(seed)) {
      issues.error("seed", "世界文件缺少有效的 seed（种子必须为有限数字）");
    }

    const fallback = createDefaultDocument();
    // Algorithm migration: absent / < 2 means a legacy world; force the old
    // fBm terrain so imported worlds keep their exact pre-v0.5 appearance.
    let algorithmVersion: number | undefined;
    if (input.algorithmVersion !== undefined) {
      if (isFiniteNumber(input.algorithmVersion)) {
        const rounded = Math.round(input.algorithmVersion);
        if (rounded !== input.algorithmVersion) {
          issues.add("algorithmVersion", "算法版本已取整");
        }
        algorithmVersion = rounded;
      } else {
        issues.add("algorithmVersion", "算法版本不是有效数字，按旧世界处理");
      }
    }
    const params = normalizeParams(input.params, issues);
    const legacy = !(typeof algorithmVersion === "number" && algorithmVersion >= 2);
    if (legacy) {
      params.terrainModel = "fbm";
    } else if (params.terrainModel === undefined) {
      params.terrainModel = "plates";
    }
    const name =
      normalizeText(input.name, MAX_NAME_LENGTH) ?? fallback.name;
    if (input.name !== undefined && normalizeText(input.name, MAX_NAME_LENGTH) === null) {
      issues.add("name", "世界名称为空或类型错误，已回退为默认名称");
    }
    const id =
      typeof input.id === "string" && input.id.trim().length > 0 ? input.id : fallback.id;
    if (input.id !== undefined && id === fallback.id) {
      issues.add("id", "世界 id 无效，已生成新 id");
    }

    return {
      document: {
        version: 1,
        ...(algorithmVersion === undefined ? {} : { algorithmVersion }),
        id,
        name,
        seed: isFiniteNumber(seed) ? Math.round(seed) : fallback.seed,
        params,
        style: normalizeStyle(input.style, name, issues),
        overrides: normalizeOverrides(input.overrides, issues),
        settlements: normalizeSettlements(input.settlements, issues),
        labels: normalizeLabels(input.labels, issues),
        createdAt: normalizeTimestamp(input.createdAt, now),
        updatedAt: normalizeTimestamp(input.updatedAt, now),
      },
      issues: issues.finish(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.error("$", `世界文件解析时发生意外错误：${message}`);
    return { document: createDefaultDocument(), issues: issues.finish() };
  }
}

/**
 * Parse a JSON string and normalize it. Malformed JSON yields an `error` issue
 * and a usable fallback document instead of throwing.
 */
export function parseWorldDocumentJson(text: string): NormalizedDocument {
  if (typeof text !== "string") {
    const issues = new IssueCollector();
    issues.error("$", "JSON 输入不是字符串");
    return { document: createDefaultDocument(), issues: issues.finish() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const issues = new IssueCollector();
    const message = error instanceof Error ? error.message : String(error);
    issues.error("$", `JSON 解析失败：${message}`);
    return { document: createDefaultDocument(), issues: issues.finish() };
  }
  return normalizeWorldDocument(parsed);
}
