/** 4096 export timing using the real pipeline (same path as the server). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createDefaultDocument, createPipeline } from "@atlas/core";
import { renderWorld, type Ctx2D } from "../src/index";
import { installNodeFonts } from "../src/node-fonts";
import { encodeCanvasPng } from "../src/png-node";

const outDir = join(process.cwd(), "out");
mkdirSync(outDir, { recursive: true });
installNodeFonts(GlobalFonts, { quiet: true });
const size = Number(process.argv[2] ?? 4096);
const seed = Number(process.argv[3] ?? 20261018);
const simSize = Number(process.argv[4] ?? Math.min(2048, size));
const document = createDefaultDocument({
  name: "Aetheris",
  seed,
  style: { labelDensity: 0.8, paperTexture: 0.62, hillshadeStrength: 0.65, coastHatching: 0.7 },
});
const t0 = performance.now();
const layers = createPipeline().generate({ document, size: simSize });
const simMs = performance.now() - t0;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext("2d");
const t1 = performance.now();
const stats = renderWorld({ ctx: ctx as unknown as Ctx2D, width: size, height: size, document, layers, quality: "export" });
const renderMs = performance.now() - t1;
const t2 = performance.now();
const fastPng = encodeCanvasPng(canvas as any);
const fastMs = performance.now() - t2;
const t3 = performance.now();
const skiaPng = canvas.toBuffer("image/png");
const skiaMs = performance.now() - t3;
const file = join(outDir, `dev-large-${size}.png`);
writeFileSync(file, fastPng);
console.log(JSON.stringify({ size, simSize, simMs: Math.round(simMs), renderMs: Math.round(renderMs), fastPngMs: Math.round(fastMs), fastBytes: fastPng.length, skiaPngMs: Math.round(skiaMs), skiaBytes: skiaPng.length, totalFastMs: Math.round(simMs + renderMs + fastMs), stats }, null, 1));
