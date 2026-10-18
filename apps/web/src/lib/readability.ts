/**
 * Readability adapter: core `assessWorldMetrics` (finalized) + local style
 * heuristics until render's `assessMapReadability` lands.
 */
import {
  assessWorldMetrics,
  type RenderStyle,
  type WorldDocument,
  type WorldLayers,
  type WorldParams,
} from "@atlas/core";
import { assessMapReadability } from "@atlas/render";
import type { ReadabilityReport as RenderReadabilityReport } from "@atlas/render";

export type {
  ReadabilityFix,
  ReadabilityIssue,
  ReadabilityReport,
} from "@atlas/render";

/**
 * Renderer readability assessment (finalized API, ~5–6ms@1024).
 * Falls back to the local metrics heuristic when the renderer cannot run.
 */
export function assessReadabilityWithRender(
  canvas: HTMLCanvasElement | null,
  document: WorldDocument,
  layers: WorldLayers | null,
): RenderReadabilityReport | null {
  if (!canvas || !layers) return null;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return assessMapReadability({
      ctx: ctx as unknown as Parameters<typeof assessMapReadability>[0]["ctx"],
      document,
      layers,
      width: canvas.width,
      height: canvas.height,
      quality: "preview",
    });
  } catch {
    return null;
  }
}

interface LocalReadabilityIssue {
  id: string;
  label: string;
  count: number;
}

interface LocalReadabilityFix {
  style?: Partial<RenderStyle>;
  params?: Partial<WorldParams>;
}

interface LocalReadabilityReport {
  level: "warn" | "fail";
  issues: LocalReadabilityIssue[];
  fixes: LocalReadabilityFix[];
}

export function assessReadabilityLocal(
  document: WorldDocument,
  layers: WorldLayers | null,
): LocalReadabilityReport | null {
  if (!layers) return null;
  const metrics = assessWorldMetrics(layers);
  const issues: LocalReadabilityIssue[] = [];
  const fixes: LocalReadabilityFix[] = [];
  const style = document.style;
  const flags = metrics.flags;

  if (flags.tooMuchWater) {
    issues.push({ id: "too-much-water", label: "水域过多、陆地太碎", count: Math.max(1, Math.round((0.12 - metrics.landFraction) * 100)) });
    fixes.push({ params: { seaLevel: Math.max(0.2, document.params.seaLevel - 0.06) } });
  }
  if (flags.tooLittleWater) {
    issues.push({ id: "too-little-water", label: "陆地过多、缺少海岸", count: Math.max(1, Math.round((metrics.landFraction - 0.85) * 100)) });
    fixes.push({ params: { seaLevel: Math.min(0.6, document.params.seaLevel + 0.05) } });
  }
  if (flags.noRivers) {
    issues.push({ id: "no-rivers", label: "几乎没有河流", count: 1 });
    fixes.push({ params: { riverDensity: Math.min(1, document.params.riverDensity + 0.12) } });
  } else if (style.showRivers && metrics.riverCount < 4) {
    issues.push({ id: "few-rivers", label: "河流偏少", count: Math.max(1, 4 - metrics.riverCount) });
    fixes.push({ params: { riverDensity: Math.min(1, document.params.riverDensity + 0.08) } });
  }
  if (flags.tooSparse) {
    issues.push({ id: "too-sparse", label: "城镇过于稀疏", count: Math.max(1, 8 - metrics.settlements) });
    fixes.push({ params: { continentScale: Math.max(0.5, document.params.continentScale - 0.1) } });
  }
  if (flags.tooDense) {
    issues.push({ id: "too-dense", label: "城镇过于密集", count: metrics.settlements - 80 });
    fixes.push({ params: { continentScale: Math.min(2, document.params.continentScale + 0.1) } });
  }
  if (flags.lowBiomeDiversity) {
    issues.push({ id: "low-biomes", label: "生态过于单一", count: Math.max(1, 3 - metrics.biomeKinds) });
    fixes.push({ params: { temperatureOffset: document.params.temperatureOffset + 0.06 } });
  }
  if (style.paperTexture > 0.86 && style.hillshadeStrength < 0.4) {
    issues.push({ id: "low-contrast", label: "纸纹过重、地形对比偏弱", count: 1 });
    fixes.push({ style: { paperTexture: 0.58, hillshadeStrength: 0.6 } });
  }
  if (issues.length === 0) return null;
  return {
    level: issues.length >= 3 || flags.tooMuchWater || flags.tooLittleWater ? "fail" : "warn",
    issues,
    fixes,
  };
}

export function formatReadabilityIssues(report: LocalReadabilityReport): string {
  return report.issues
    .slice(0, 3)
    .map((issue) => `${issue.label}${issue.count > 1 ? ` ${issue.count} 处` : ""}`)
    .join(" · ");
}
