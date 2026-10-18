/**
 * Node-side QA renderer (M0): proves core + render work without a browser and
 * produces PNGs for visual review: pnpm qa:render
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createDefaultDocument, createPipeline } from "@atlas/core";
import { renderWorld, type Ctx2D } from "@atlas/render";

const OUT_DIR = join(process.cwd(), "out");
const SIZE = 1024;
const SEEDS = [101, 202, 303];

mkdirSync(OUT_DIR, { recursive: true });

const pipeline = createPipeline();

for (const seed of SEEDS) {
  const document = createDefaultDocument({ name: `QA World ${seed}`, seed });
  const layers = pipeline.generate({ document, size: SIZE });
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width: SIZE,
    height: SIZE,
    document,
    layers,
    quality: "preview",
  });
  const file = join(OUT_DIR, `qa-seed-${seed}.png`);
  writeFileSync(file, canvas.toBuffer("image/png"));
  console.log(
    `${file}  sim=${layers.size}  land=${(layers.stats.landFraction * 100).toFixed(1)}%  total=${Math.round(layers.stats.totalMs)}ms`,
  );
}

console.log("QA render done.");
