/**
 * Shared map-content measurement entry points (v1.2.0).
 *
 * `measureMapContent` is the public hit-testing API introduced in v1.1.0; the
 * richer `measureMapContentDetailed` variant also exposes the layout counters
 * (drawn / skipped / settlement names) that readability scoring needs. Both run
 * the exact same layout pass that `renderWorld` paints.
 */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import { planDecorations } from "./decor";
import { layoutMapLabels, type MeasuredLabel } from "./labels";
import type { RenderPass } from "./pass";
import { resolveTheme, type Quality } from "./style";

export interface MeasureMapContentInput {
  ctx: Ctx2D;
  document: WorldDocument;
  layers: WorldLayers;
  width: number;
  height: number;
  /** Defaults to export when the shorter edge is >= 2048, preview otherwise. */
  quality?: Quality;
}

export interface MapContentMeasurement {
  labels: MeasuredLabel[];
  drawn: number;
  skipped: number;
  settlementNames: number;
  settlements: number;
}

export function measureMapContentDetailed(input: MeasureMapContentInput): MapContentMeasurement {
  const { ctx, document, layers, width, height } = input;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(`invalid measure size ${width}x${height}`);
  }
  const quality: Quality =
    input.quality ?? (Math.min(width, height) >= 2048 ? "export" : "preview");
  const theme = resolveTheme(document.style, quality);
  const size = Math.min(width, height);
  const scale = size / 1024;
  const seed = (document.seed | 0) || 1;
  const seaLevel = Math.min(0.95, Math.max(0.05, document.params.seaLevel));
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
  // Decorations reserve the same avoid rects as renderWorld (cartouche, compass,
  // legend, scale bar) so measured boxes match the painted result.
  const avoid = planDecorations(pass).avoid;
  ctx.save();
  try {
    const layout = layoutMapLabels(ctx, {
      width,
      height,
      scale,
      theme,
      seed,
      quality,
      document,
      layers,
      avoid,
    });
    return {
      labels: layout.measured,
      drawn: layout.drawn,
      skipped: layout.skipped,
      settlementNames: layout.settlementNames,
      settlements: layout.settlements,
    };
  } finally {
    ctx.restore();
  }
}

/**
 * Hit-testing / layout API: exact image-space boxes of the labels and
 * settlement markers that `renderWorld` would paint for the same document /
 * layers / size. Hidden or collision-skipped entries are omitted.
 *
 * Pure with respect to the document: only `ctx` is queried for `measureText`,
 * and its state is restored before returning.
 */
export function measureMapContent(input: MeasureMapContentInput): MeasuredLabel[] {
  return measureMapContentDetailed(input).labels;
}
