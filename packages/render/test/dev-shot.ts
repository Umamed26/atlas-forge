/**
 * Developer visual harness: renders the synthetic showcase world to PNG files
 * so the parchment look can be reviewed without the full pipeline or browser.
 *
 *   pnpm -C packages/render exec tsx test/dev-shot.ts [sizes...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createSyntheticWorld } from "../src/testing";
import { renderWorld, type Ctx2D, type RenderStats } from "../src/index";
import { installNodeFonts } from "../src/node-fonts";

const outDir = join(process.cwd(), "out");
mkdirSync(outDir, { recursive: true });
installNodeFonts(GlobalFonts, { quiet: true });

const sizes = process.argv.slice(2).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
if (sizes.length === 0) sizes.push(1024);

function shot(name: string, size: number, preset: "parchment-classic" | "aged-ink", quality: "preview" | "export"): RenderStats {
  const world = createSyntheticWorld({ size: Math.min(1024, Math.max(64, size / 2)), seed: 424242, preset });
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const started = performance.now();
  const stats = renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width: size,
    height: size,
    document: world.document,
    layers: world.layers,
    quality,
  });
  const png = canvas.toBuffer("image/png");
  const total = performance.now() - started;
  const file = join(outDir, name);
  writeFileSync(file, png);
  console.log(
    `${file}  render=${stats.totalMs.toFixed(1)}ms  with-png=${total.toFixed(1)}ms  bytes=${(png.length / 1024).toFixed(0)}KB  ` +
      `coast=${stats.coastLines} lake=${stats.lakeLines} mtn=${stats.mountainGlyphs} rivers=${stats.riverCount} labels=${stats.labelsDrawn}/${stats.labelsDrawn + stats.labelsSkipped} ` +
      `font=${stats.fontFamily} raster=${stats.rasterMs} field=${stats.themeFieldMs}`,
  );
  return stats;
}

for (const size of sizes) {
  shot(`dev-classic-${size}.png`, size, "parchment-classic", size >= 2048 ? "export" : "preview");
  shot(`dev-aged-${size}.png`, size, "aged-ink", size >= 2048 ? "export" : "preview");
}
