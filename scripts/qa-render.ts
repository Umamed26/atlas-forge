/**
 * Node-side renderer QA (M5).
 *
 *   pnpm qa:render
 *
 * Produces reviewable PNGs with the real generator + the shared renderer:
 *   out/qa-seed-101.png, qa-seed-202.png, qa-seed-303.png   (1024 preview)
 *   out/qa-seed-101-aged-ink.png                            (style-only re-render)
 *   out/qa-large-4096.png                                   (4096 export, sim 2048)
 *
 * Prints per-stage timings (simulation / renderer phases / PNG encode) and
 * structural metrics so regressions are visible without opening the images.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import {
  createDefaultDocument,
  createPipeline,
  getScenarioPreset,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";
import { RENDERER_VERSION, renderSvg, renderWorld, type Ctx2D, type RenderStats } from "@atlas/render";
import { installNodeFonts } from "@atlas/render/node-fonts";
import { encodeCanvasPng } from "@atlas/render/png";

const OUT_DIR = join(process.cwd(), "out");
const PREVIEW_SIZE = 1024;
const LARGE_SIZE = 4096;
const SEEDS = [101, 202, 303];

mkdirSync(OUT_DIR, { recursive: true });
const fontInfo = installNodeFonts(GlobalFonts, { quiet: true });
const pipeline = createPipeline();

interface ShotResult {
  file: string;
  size: number;
  simSize: number;
  simMs: number;
  renderMs: number;
  encodeMs: number;
  totalMs: number;
  bytes: number;
  stats: RenderStats;
  layers: WorldLayers;
}

function describe(stats: RenderStats): string {
  return (
    `coast=${stats.coastLines} lakes=${stats.lakeLines} rivers=${stats.riverCount} ` +
    `mtn=${stats.mountainGlyphs} forest=${stats.forestGlyphs} ` +
    `labels=${stats.labelsDrawn}/${stats.labelsDrawn + stats.labelsSkipped} ` +
    `settlements=${stats.settlements} land=${(stats.landFraction * 100).toFixed(1)}% ` +
    `font=${stats.fontFamily}`
  );
}

function renderShot(
  file: string,
  document: WorldDocument,
  size: number,
  simSize: number,
  quality: "preview" | "export",
  fastPng: boolean,
): ShotResult {
  const simStart = performance.now();
  const layers = pipeline.generate({ document, size: simSize });
  const simMs = performance.now() - simStart;

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const renderStart = performance.now();
  const stats = renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width: size,
    height: size,
    document,
    layers,
    quality,
  });
  const renderMs = performance.now() - renderStart;

  const encodeStart = performance.now();
  const png = fastPng ? encodeCanvasPng(canvas as unknown as { width: number; height: number; data(): Uint8Array }) : canvas.toBuffer("image/png");
  const encodeMs = performance.now() - encodeStart;
  const path = join(OUT_DIR, file);
  writeFileSync(path, png);
  return {
    file: path,
    size,
    simSize,
    simMs,
    renderMs,
    encodeMs,
    totalMs: simMs + renderMs + encodeMs,
    bytes: png.length,
    stats,
    layers,
  };
}

function report(title: string, shot: ShotResult): void {
  console.log(`\n${title}`);
  console.log(`  png            ${shot.file}  (${(shot.bytes / 1024).toFixed(0)} KB, ${shot.size}x${shot.size}, sim ${shot.simSize})`);
  console.log(
    `  time           sim=${shot.simMs.toFixed(0)}ms  render=${shot.renderMs.toFixed(1)}ms  ` +
      `encode=${shot.encodeMs.toFixed(0)}ms  total=${shot.totalMs.toFixed(0)}ms`,
  );
  console.log(
    `  renderer       raster=${shot.stats.rasterMs} field=${shot.stats.themeFieldMs} ` +
      `coast=${shot.stats.coastMs} river=${shot.stats.riverMs} label=${shot.stats.labelMs} decor=${shot.stats.decorMs}`,
  );
  console.log(`  content        ${describe(shot.stats)}`);
}

console.log(
  `Atlas Forge render QA · renderer ${RENDERER_VERSION} · node ${process.version} · ` +
    `fonts ${fontInfo.family} (${fontInfo.source})`,
);

// Warm up the JIT so reported preview timings reflect steady state (first pass
// is still reported as "cold" below).
const warmDoc = createDefaultDocument({ name: "QA Warmup", seed: 1 });
const warmLayers = pipeline.generate({ document: warmDoc, size: 512 });
const warmCanvas = createCanvas(1024, 1024);
renderWorld({
  ctx: warmCanvas.getContext("2d") as unknown as Ctx2D,
  width: 1024,
  height: 1024,
  document: warmDoc,
  layers: warmLayers,
  quality: "preview",
});

for (const seed of SEEDS) {
  const document = createDefaultDocument({
    name: `QA World ${seed}`,
    seed,
    style: { labelDensity: 0.8, paperTexture: 0.62, hillshadeStrength: 0.65, coastHatching: 0.7 },
  });
  const shot = renderShot(`qa-seed-${seed}.png`, document, PREVIEW_SIZE, PREVIEW_SIZE, "preview", false);
  report(`seed ${seed} · parchment-classic (preview 1024)`, shot);

  // Warm re-render (same layers): the interactive steady-state frame budget.
  const warmCanvas = createCanvas(PREVIEW_SIZE, PREVIEW_SIZE);
  const warmStart = performance.now();
  renderWorld({
    ctx: warmCanvas.getContext("2d") as unknown as Ctx2D,
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    document,
    layers: shot.layers,
    quality: "preview",
  });
  console.log(`  warm re-render ${(performance.now() - warmStart).toFixed(1)}ms (target <=120ms)`);

  if (seed === SEEDS[0]) {
    // Style-only re-render: same layers, zero simulation cost (the product claim).
    const agedDocument: WorldDocument = {
      ...document,
      style: { ...document.style, preset: "aged-ink" },
    };
    const aged = renderShot(`qa-seed-${seed}-aged-ink.png`, agedDocument, PREVIEW_SIZE, PREVIEW_SIZE, "preview", false);
    report(`seed ${seed} · aged-ink (style-only re-render 1024)`, aged);
  }
}

const largeDocument = createDefaultDocument({
  name: "QA Large World",
  seed: SEEDS[0],
  style: { labelDensity: 0.8, paperTexture: 0.62, hillshadeStrength: 0.65, coastHatching: 0.7 },
});
const large = renderShot(`qa-large-${LARGE_SIZE}.png`, largeDocument, LARGE_SIZE, 2048, "export", true);
report(`large export ${LARGE_SIZE} (export, sim 2048, zlib+up-filter PNG)`, large);

console.log(
  `\nQA render done · ${SEEDS.length} preview seeds + aged-ink + one ${LARGE_SIZE} export · renderer ${RENDERER_VERSION}`,
);

// ── appended visual regression check (skips until baselines are committed) ──
try {
  const { runVisualCompare } = await import("./visual-lib");
  console.log("\nVisual regression (packages/render/test/baselines):");
  const visual = await runVisualCompare({ missingBaseline: "skip" });
  if (!visual.skipped && !visual.ok) {
    console.error(
      "visual regression FAILED (tolerant structural judge) — " +
        "refresh baselines with `pnpm qa:visual -- --update` only for intentional visual changes",
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.warn(
    `visual regression skipped: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ── Vector export smoke test (v0.5) ───────────────────────────────────────
{
  const preset = getScenarioPreset("classic")!;
  const document = createDefaultDocument({
    name: "QA Vector World",
    seed: 101,
    params: { ...preset.params, namingLanguage: "latin", gridSize: 1024 },
    style: { ...preset.style, title: "QA Vector World" },
  });
  const layers = pipeline.generate({ document, size: 1024 });
  const startedAt = performance.now();
  const svg = renderSvg({ document, layers, width: 1024, height: 1024, quality: "preview" });
  const elapsed = performance.now() - startedAt;
  const file = join(OUT_DIR, "qa-export.svg");
  writeFileSync(file, svg);
  console.log(`  svg            ${file}  (${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB, ${elapsed.toFixed(0)}ms)`);
}
