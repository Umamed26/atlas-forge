/** Render a real pipeline world for visual review. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createDefaultDocument, createPipeline } from "@atlas/core";
import { renderWorld, type Ctx2D } from "../src/index";
import { installNodeFonts } from "../src/node-fonts";

const outDir = join(process.cwd(), "out");
mkdirSync(outDir, { recursive: true });
installNodeFonts(GlobalFonts, { quiet: true });

const seeds = process.argv.slice(2).map(Number).filter((v) => Number.isFinite(v));
if (seeds.length === 0) seeds.push(20261018);
const size = 1024;
for (const seed of seeds) {
  for (const preset of ["parchment-classic", "aged-ink"] as const) {
  const document = createDefaultDocument({
    name: "Aetheris",
    seed,
    style: {
      preset,
      labelDensity: 0.8,
      paperTexture: 0.62,
      hillshadeStrength: 0.65,
      coastHatching: 0.7,
    },
  });
  const t0 = performance.now();
  const layers = createPipeline().generate({ document, size });
  const simMs = performance.now() - t0;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const stats = renderWorld({ ctx: ctx as unknown as Ctx2D, width: size, height: size, document, layers, quality: "preview" });
  // Second render to measure warm (JIT-compiled) timing.
  const warm = renderWorld({ ctx: ctx as unknown as Ctx2D, width: size, height: size, document, layers, quality: "preview" });
  const png = canvas.toBuffer("image/png");
  const file = join(outDir, `dev-real-${seed}-${preset}.png`);
  writeFileSync(file, png);
  console.log(`${file} sim=${layers.size} simMs=${simMs.toFixed(0)} render(cold)=${stats.totalMs}ms render(warm)=${warm.totalMs}ms raster=${warm.rasterMs} field=${warm.themeFieldMs} coast=${warm.coastMs} river=${warm.riverMs} label=${warm.labelMs} decor=${warm.decorMs} rivers=${warm.riverCount} forest=${warm.forestGlyphs} labels=${warm.labelsDrawn} settlements=${warm.settlements} mtn=${warm.mountainGlyphs} land=${(layers.stats.landFraction*100).toFixed(1)}%`);
  }
}
