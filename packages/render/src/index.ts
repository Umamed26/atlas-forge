/**
 * Atlas Forge parchment renderer.
 *
 * One implementation for the browser (`CanvasRenderingContext2D`) and Node
 * (`@napi-rs/canvas`): callers pass the native context cast to `Ctx2D`. The
 * pipeline is
 *
 *   raster (ImageData) → sea/coast ink → lakes → rivers → graticule →
 *   labels & settlements → frame / cartouche / compass / scale / legend → ageing
 *
 * `renderWorld` is a pure function of (document, layers, output size, quality):
 * no Math.random, no Date, no DOM. Identical inputs produce identical pixels on
 * both platforms and at every output size.
 */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import { buildCoastData, drawCoastline, drawLakes, drawSea } from "./coast";
import { planDecorations } from "./decor";
import { extractRivers, drawRivers, type RiverPath } from "./hydro";
import { drawLabels, type LabelStats } from "./labels";
import { drawMountainGlyphs } from "./mountains";
import { drawForestGlyphs } from "./forests";
import { buildTerrainField, getPaperTexture, rasterizeParchment } from "./raster";
import { resolveTheme, type Quality } from "./style";
import type { RenderPass } from "./pass";

export const RENDERER_VERSION = "1.3.0";

export interface RenderWorldInput {
  ctx: Ctx2D;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  document: WorldDocument;
  layers: WorldLayers;
  /** Quality tier. Defaults to export for outputs >= 2048 px, preview below. */
  quality?: Quality;
}

export interface RenderStats {
  version: string;
  quality: Quality;
  preset: string;
  width: number;
  height: number;
  simSize: number;
  themeFieldMs: number;
  rasterMs: number;
  coastMs: number;
  riverMs: number;
  labelMs: number;
  decorMs: number;
  totalMs: number;
  coastLines: number;
  lakeLines: number;
  mountainGlyphs: number;
  forestGlyphs: number;
  riverCount: number;
  labelsDrawn: number;
  labelsSkipped: number;
  settlementNames: number;
  settlements: number;
  landFraction: number;
  fontFamily: string;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function validateInputs(input: RenderWorldInput): void {
  const { width, height, document, layers } = input;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(`invalid render size ${width}x${height}`);
  }
  if (!document || typeof document !== "object" || !document.params || !document.style) {
    throw new Error("invalid world document passed to renderWorld");
  }
  if (!layers || !Number.isFinite(layers.size) || layers.size < 2) {
    throw new Error("invalid world layers passed to renderWorld");
  }
  const cells = layers.size * layers.size;
  const required: Array<[string, ArrayLike<number> | undefined]> = [
    ["height", layers.height],
    ["filled", layers.filled],
    ["ocean", layers.ocean],
    ["lake", layers.lake],
    ["river", layers.river],
    ["flow", layers.flow],
    ["biome", layers.biome],
  ];
  for (const [name, array] of required) {
    if (!array || array.length < cells || array.length > cells * 4) {
      throw new Error(`world layers.${name} has unexpected length (expected ${cells})`);
    }
  }
}

/** Render one parchment world map into the provided 2D context. */
export function renderWorld(input: RenderWorldInput): RenderStats {
  validateInputs(input);
  const totalStart = now();
  const { ctx, width, height, document, layers } = input;
  const quality: Quality =
    input.quality ?? (Math.min(width, height) >= 2048 ? "export" : "preview");
  const seed = (document.seed | 0) || 1;
  const seaLevel = Math.min(0.95, Math.max(0.05, document.params.seaLevel));
  const theme = resolveTheme(document.style, quality);
  const size = Math.min(width, height);
  const scale = size / 1024;

  ctx.save();
  try {
    const pass: RenderPass = {
      ctx,
      width,
      height,
      size,
      scale,
      theme,
      seed,
      quality,
      document,
      layers,
      seaLevel,
    };
    const fieldStart = now();
    const fieldSize =
      quality === "preview"
        ? Math.min(layers.size, 384)
        : Math.min(layers.size, 2048);
    const field = buildTerrainField(layers, seaLevel, theme, seed, fieldSize);
    const paper = getPaperTexture(theme, seed, quality);
    const fieldMs = now() - fieldStart;

    const raster = rasterizeParchment(
      ctx,
      width,
      height,
      field,
      paper,
      theme,
      seed,
      quality,
      fieldMs,
    );

    const forestGlyphs = drawForestGlyphs(pass);
    const mountainGlyphs = drawMountainGlyphs(pass, field.maxLand);

    const coastStart = now();
    const traceSize =
      quality === "preview"
        ? Math.min(layers.size, 384)
        : Math.min(layers.size, 1536);
    const coastData = buildCoastData(layers, seaLevel, traceSize);
    drawSea(ctx, {
      width,
      height,
      scale,
      theme,
      seed,
      quality,
      layers,
      seaLevel,
    }, coastData);
    drawCoastline(ctx, { width, height, scale, theme, seed, quality, layers, seaLevel }, coastData);
    drawLakes(ctx, { width, height, scale, theme, seed, quality, layers, seaLevel }, coastData);
    const coastMs = now() - coastStart;

    const riverStart = now();
    let rivers: RiverPath[] = [];
    if (document.style.showRivers && layers.river) {
      rivers = extractRivers(layers, {
        maxRivers: quality === "export" ? 190 : 46,
        minFlowRatio: quality === "export" ? 0.0025 : 0.006,
        smoothing: 3,
      });
      drawRivers(ctx, rivers, { width, height, scale, theme, seed, bankStroke: quality === "export" });
    }
    const riverMs = now() - riverStart;

    const decor = planDecorations(pass);

    const labelStart = now();
    let labelStats: LabelStats = {
      drawn: 0,
      settlements: 0,
      settlementNames: 0,
      skipped: 0,
      fontFamily: "",
    };
    if (document.style.showLabels) {
      decor.drawUnder();
      labelStats = drawLabels(ctx, {
        width,
        height,
        scale,
        theme,
        seed,
        quality,
        document,
        layers,
        avoid: decor.avoid,
      });
    }
    const labelMs = now() - labelStart;

    const decorStart = now();
    decor.drawOver();
    const decorMs = now() - decorStart;

    return {
      version: RENDERER_VERSION,
      quality,
      preset: theme.preset,
      width,
      height,
      simSize: layers.size,
      themeFieldMs: Number(raster.fieldMs.toFixed(2)),
      rasterMs: Number(raster.rasterMs.toFixed(2)),
      coastMs: Number(coastMs.toFixed(2)),
      riverMs: Number(riverMs.toFixed(2)),
      labelMs: Number(labelMs.toFixed(2)),
      decorMs: Number(decorMs.toFixed(2)),
      totalMs: Number((now() - totalStart).toFixed(2)),
      coastLines: coastData.coast.length,
      mountainGlyphs,
      forestGlyphs,
      lakeLines: coastData.lakes.length,
      riverCount: rivers.length,
      labelsDrawn: labelStats.drawn,
      labelsSkipped: labelStats.skipped,
      settlementNames: labelStats.settlementNames,
      settlements: labelStats.settlements,
      landFraction: Number((layers.stats?.landFraction ?? 0).toFixed(4)),
      fontFamily: labelStats.fontFamily || "fallback serif",
    };
  } finally {
    ctx.restore();
  }
}

// ── v1.1.0: hit-testing layout API ───────────────────────────────────────
export { measureMapContent, measureMapContentDetailed } from "./measure";
export type { MeasureMapContentInput, MapContentMeasurement } from "./measure";

// ── v1.2.0: non-blocking readability assessment ──────────────────────────
export { assessMapReadability } from "./readability";
export type {
  AssessMapReadabilityInput,
  ReadabilityFix,
  ReadabilityIssue,
  ReadabilityIssueId,
  ReadabilityMetrics,
  ReadabilityReport,
  ReadabilitySeverity,
} from "./readability";

export { resolveTheme } from "./style";
export type { Quality, RenderTheme } from "./style";
export type { Ctx2D } from "./canvas-types";
export type { Gradient2D, ImageDataLike } from "./canvas-types";
export { BUNDLED_FONT_FAMILY, configureRenderFonts, getRenderFonts, installBrowserFonts } from "./fonts";
export type { RenderFontConfig } from "./fonts";
export { extractRivers } from "./hydro";
export { buildCoastData } from "./coast";
export { defaultDocumentForRenderTests } from "./testing";
