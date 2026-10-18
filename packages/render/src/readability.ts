/**
 * Map readability assessment (v1.2.0) — additive, non-blocking preflight for
 * the UI after a generation or preset switch.
 *
 * It reuses the renderer's own layout (`measureMapContentDetailed`) so label
 * collision / overflow numbers are derived from the boxes that are actually
 * painted, then combines them with cheap layer statistics and a coarse
 * ink-vs-parchment contrast estimate. The output carries actionable `fixes`
 * (WorldParams / RenderStyle values the UI can apply and regenerate).
 *
 * Do NOT call this per frame: it costs a label layout + one linear layer scan
 * (~5ms at 1024²). Call it once after generation completes / preset changes.
 */
import { Biome, type RenderStyle, type WorldDocument, type WorldLayers, type WorldParams } from "@atlas/core";
import * as atlasCore from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import type { Rect } from "./layout";
import { measureMapContentDetailed } from "./measure";
import { resolveTheme, type Quality } from "./style";

export type ReadabilityIssueId =
  | "too-much-water"
  | "too-little-water"
  | "label-collisions"
  | "labels-overflow"
  | "no-rivers"
  | "settlements-sparse"
  | "low-biome-diversity"
  | "text-low-contrast";

export type ReadabilitySeverity = "warn" | "fail";

export interface ReadabilityFix {
  param?: keyof WorldParams;
  style?: keyof RenderStyle;
  value: number | string | boolean;
}

export interface ReadabilityIssue {
  id: ReadabilityIssueId;
  severity: ReadabilitySeverity;
  message: string;
  count?: number;
  fixes: ReadabilityFix[];
}

export interface ReadabilityMetrics {
  landFraction: number;
  rivers: number;
  labelsDrawn: number;
  labelsSkipped: number;
  collisions: number;
  overflow: number;
  settlements: number;
  biomeKinds: number;
}

export interface ReadabilityReport {
  /** 0 (unreadable) .. 100 (clean). */
  score: number;
  issues: ReadabilityIssue[];
  metrics: ReadabilityMetrics;
}

export interface AssessMapReadabilityInput {
  ctx: Ctx2D;
  document: WorldDocument;
  layers: WorldLayers;
  width: number;
  height: number;
  quality?: Quality;
}

// ── small numeric helpers ─────────────────────────────────────────────────
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: readonly [number, number, number]): number {
  return 0.2126 * srgbChannel(color[0]) + 0.7152 * srgbChannel(color[1]) + 0.0722 * srgbChannel(color[2]);
}

function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ── layer statistics (reuses core's assessWorldMetrics when it lands) ─────
interface CoreWorldMetrics {
  landFraction?: number;
  riverCells?: number;
  riverCount?: number;
  settlements?: number;
  labels?: number;
  biomeKinds?: number;
  flags?: Partial<Record<string, boolean>>;
}

interface LayerMetrics {
  landFraction: number;
  riverCells: number;
  settlements: number;
  biomeKinds: number;
  flags: Partial<Record<string, boolean>>;
}

const coreAssess = (atlasCore as unknown as {
  assessWorldMetrics?: (layers: WorldLayers) => CoreWorldMetrics;
}).assessWorldMetrics;

function computeLayerMetrics(layers: WorldLayers): LayerMetrics {
  let core: CoreWorldMetrics | undefined;
  if (typeof coreAssess === "function") {
    try {
      core = coreAssess(layers);
    } catch {
      core = undefined;
    }
  }
  const settlements =
    Number.isFinite(core?.settlements) ? (core!.settlements as number) : (layers.settlements?.length ?? 0);
  const flags = core?.flags ?? {};

  // If core already reports every physical metric we need, skip the linear scan.
  const hasAll =
    Number.isFinite(core?.landFraction) &&
    Number.isFinite(core?.riverCells) &&
    Number.isFinite(core?.biomeKinds);
  if (hasAll) {
    return {
      landFraction: core!.landFraction as number,
      riverCells: core!.riverCells as number,
      settlements,
      biomeKinds: core!.biomeKinds as number,
      flags,
    };
  }

  const size = Math.max(1, layers.size);
  const cells = size * size;
  let land = 0;
  let riverCells = 0;
  const biomes = new Set<number>();
  for (let i = 0; i < cells; i += 1) {
    if (layers.ocean[i] || layers.lake[i]) continue;
    land += 1;
    const biome = layers.biome[i];
    if (biome !== Biome.Ocean && biome !== Biome.Lake) biomes.add(biome);
    if (layers.river[i]) riverCells += 1;
  }
  const computedLand = cells > 0 ? land / cells : 0;
  const statsLand = layers.stats?.landFraction;
  return {
    landFraction:
      Number.isFinite(core?.landFraction) ? (core!.landFraction as number) : Number.isFinite(statsLand) ? statsLand : computedLand,
    riverCells: Number.isFinite(core?.riverCells) ? (core!.riverCells as number) : riverCells,
    settlements,
    biomeKinds: Number.isFinite(core?.biomeKinds) ? (core!.biomeKinds as number) : biomes.size,
    flags,
  };
}

// ── issue construction helpers ────────────────────────────────────────────
function labelFixes(density: number): ReadabilityFix[] {
  return [
    { style: "labelDensity", value: round2(clamp(density * 0.8, 0.1, 1)) },
    { style: "showLabels", value: false },
  ];
}

function waterFixes(params: WorldParams, delta: number): ReadabilityFix[] {
  return [
    { param: "seaLevel", value: round2(clamp(params.seaLevel + delta, 0.2, 0.7)) },
    { param: "continentality", value: round2(clamp(params.continentality + delta * 1.2, 0, 1)) },
  ];
}

/** Assess whether a generated map will read well. Never blocks rendering. */
export function assessMapReadability(input: AssessMapReadabilityInput): ReadabilityReport {
  const { ctx, document, layers, width, height } = input;
  const quality: Quality =
    input.quality ?? (Math.min(width, height) >= 2048 ? "export" : "preview");
  const theme = resolveTheme(document.style, quality);
  const scale = Math.min(width, height) / 1024;
  const measurement = measureMapContentDetailed({ ctx, document, layers, width, height, quality });
  const layer = computeLayerMetrics(layers);

  // ── label geometry from the renderer's own layout boxes ────────────────
  const boxes = measurement.labels;
  const contentInset = Math.max(4, theme.decor.frameInnerInset * scale);
  let collisions = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    const rectA: Rect = { x: a.x, y: a.y, w: a.width, h: a.height };
    for (let j = i + 1; j < boxes.length; j += 1) {
      const b = boxes[j];
      // Rotation boxes are already AABBs; a pixel of touch does not count.
      if (overlaps(rectA, { x: b.x, y: b.y, w: b.width, h: b.height })) {
        const overlapW =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapH =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (overlapW * overlapH >= 1) collisions += 1;
      }
    }
  }
  let overflow = 0;
  for (const box of boxes) {
    if (
      box.x < contentInset ||
      box.y < contentInset ||
      box.x + box.width > width - contentInset ||
      box.y + box.height > height - contentInset
    ) {
      overflow += 1;
    }
  }

  // ── coarse ink-vs-parchment contrast (no raster pass) ─────────────────
  const water = clamp(1 - layer.landFraction, 0, 1);
  const landBg = theme.land.olive;
  const mixedBg: [number, number, number] = [
    landBg[0] * (1 - water) + theme.ocean.mid[0] * water,
    landBg[1] * (1 - water) + theme.ocean.mid[1] * water,
    landBg[2] * (1 - water) + theme.ocean.mid[2] * water,
  ];
  const labelContrast = contrastRatio(theme.ink.label, mixedBg);

  const params = document.params;
  const style = document.style;
  // Settlements that are actually painted (hidden ones no longer count).
  const drawnSettlements = measurement.settlements;
  const density = clamp(style.labelDensity, 0, 1);
  const labelsSkipped = measurement.skipped;
  const labelsDrawn = measurement.drawn;
  const labelTotal = labelsDrawn + labelsSkipped;
  const skippedRatio = labelTotal > 0 ? labelsSkipped / labelTotal : 0;
  // "Crowded" means most surviving label candidates were dropped for space,
  // not the normal handful of skips every busy parchment map has.
  const crowded = labelsSkipped >= 20 && skippedRatio > 0.72;

  // ── issues ────────────────────────────────────────────────────────────
  const issues: ReadabilityIssue[] = [];

  // Core thresholds (assessWorldMetrics.flags): land < 0.12 = too much water.
  if (layer.landFraction < 0.12 || layer.flags.tooMuchWater === true) {
    issues.push({
      id: "too-much-water",
      severity: "fail",
      message: `陆地只占 ${(layer.landFraction * 100).toFixed(0)}%，画面以海洋为主，可识别内容偏少`,
      fixes: waterFixes(params, -0.08),
    });
  } else if (layer.landFraction < 0.2) {
    issues.push({
      id: "too-much-water",
      severity: "warn",
      message: `陆地只占 ${(layer.landFraction * 100).toFixed(0)}%，海面较多`,
      fixes: waterFixes(params, -0.06),
    });
  }

  // Core thresholds: land > 0.85 = too little water.
  if (layer.landFraction > 0.85 || layer.flags.tooLittleWater === true) {
    issues.push({
      id: "too-little-water",
      severity: "fail",
      message: `陆地占 ${(layer.landFraction * 100).toFixed(0)}%，几乎没有海面，海岸线与港口不易辨认`,
      fixes: waterFixes(params, 0.08),
    });
  } else if (layer.landFraction > 0.8) {
    issues.push({
      id: "too-little-water",
      severity: "warn",
      message: `陆地占 ${(layer.landFraction * 100).toFixed(0)}%，海面偏少`,
      fixes: waterFixes(params, 0.06),
    });
  }

  if (collisions > 0 || crowded) {
    const parts: string[] = [];
    if (collisions > 0) parts.push(`标签相互重叠 ${collisions} 处`);
    if (crowded) parts.push(`大量标签因拥挤被省略（${labelsSkipped} 个）`);
    issues.push({
      id: "label-collisions",
      severity: collisions > 8 ? "fail" : "warn",
      message: parts.join("，"),
      count: collisions,
      fixes: labelFixes(density),
    });
  }

  if (overflow > 0) {
    issues.push({
      id: "labels-overflow",
      severity: overflow > 4 ? "fail" : "warn",
      message: `${overflow} 个标签或地点标记超出内边框`,
      count: overflow,
      fixes: [
        { style: "labelDensity", value: 0.45 },
        { style: "showLabels", value: false },
      ],
    });
  }

  if (layer.riverCells === 0 || layer.flags.noRivers === true) {
    issues.push({
      id: "no-rivers",
      severity: "fail",
      message: "地图上没有河流，水文信息缺失",
      fixes: [
        { param: "riverDensity", value: round2(clamp(Math.max(0.4, params.riverDensity) + 0.2, 0, 1)) },
        { param: "seaLevel", value: round2(clamp(params.seaLevel - 0.04, 0.2, 0.7)) },
      ],
    });
  }

  // Core threshold: settlements < 8 = sparse.
  if (drawnSettlements === 0 || (layer.flags.tooSparse === true && drawnSettlements < 8)) {
    issues.push({
      id: "settlements-sparse",
      severity: drawnSettlements === 0 ? "fail" : "warn",
      message:
        drawnSettlements === 0
          ? "地图上没有绘制出任何城镇，缺少人文信息"
          : `只绘制出 ${drawnSettlements} 个城镇，偏稀疏`,
      count: drawnSettlements,
      fixes: [
        { param: "seaLevel", value: round2(clamp(params.seaLevel - 0.05, 0.2, 0.7)) },
        { param: "riverDensity", value: round2(clamp(params.riverDensity + 0.1, 0, 1)) },
      ],
    });
  } else if (drawnSettlements < 8) {
    issues.push({
      id: "settlements-sparse",
      severity: "warn",
      message: `只绘制出 ${drawnSettlements} 个城镇，偏稀疏`,
      count: drawnSettlements,
      fixes: [
        { param: "seaLevel", value: round2(clamp(params.seaLevel - 0.05, 0.2, 0.7)) },
        { param: "riverDensity", value: round2(clamp(params.riverDensity + 0.1, 0, 1)) },
      ],
    });
  }

  // Core threshold: biomeKinds < 3 = monotonous.
  if (layer.biomeKinds < 3 || layer.flags.lowBiomeDiversity === true) {
    issues.push({
      id: "low-biome-diversity",
      severity: "warn",
      message: `只有 ${layer.biomeKinds} 种群系，地形/气候差异不明显`,
      count: layer.biomeKinds,
      fixes: [
        {
          param: "temperatureOffset",
          value: round2(clamp(params.temperatureOffset + 0.12, -0.35, 0.35)),
        },
        { param: "moistureBias", value: round2(clamp(params.moistureBias + 0.12, -0.5, 0.5)) },
        { param: "continentScale", value: round2(clamp(params.continentScale * 1.15, 0.3, 3)) },
      ],
    });
  }

  if (labelContrast < 3) {
    issues.push({
      id: "text-low-contrast",
      severity: labelContrast < 2.2 ? "fail" : "warn",
      message: `地名与纸面底色对比度偏低（约 ${labelContrast.toFixed(1)}:1）`,
      fixes: [
        { style: "paperTexture", value: round2(clamp(style.paperTexture * 0.7, 0, 1)) },
        { style: "hillshadeStrength", value: round2(clamp(style.hillshadeStrength * 0.8, 0, 1)) },
        { style: "preset", value: "parchment-classic" },
      ],
    });
  }

  // Failures first so the UI banner leads with the most important advice.
  issues.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "fail" ? -1 : 1));

  let score = 100;
  for (const issue of issues) score -= issue.severity === "fail" ? 26 : 10;
  score -= Math.min(4, collisions * 0.8);
  score -= Math.min(6, overflow * 2);
  score -= Math.min(8, (crowded ? 6 : 0) + skippedRatio * 6);

  return {
    score: clamp(Math.round(score), 0, 100),
    issues,
    metrics: {
      landFraction: Number(layer.landFraction.toFixed(3)),
      rivers: layer.riverCells,
      labelsDrawn,
      labelsSkipped,
      collisions,
      overflow,
      settlements: drawnSettlements,
      biomeKinds: layer.biomeKinds,
    },
  };
}
