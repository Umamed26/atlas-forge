import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import { renderSvgDetailed } from "@atlas/render";
import { installNodeFonts } from "@atlas/render/node-fonts";
import { createVisualFixture } from "../packages/render/test/fixtures/visualFixture";
installNodeFonts(GlobalFonts, { quiet: true });
const fx = createVisualFixture();
mkdirSync("out", { recursive: true });
for (const [w, q] of [[512, "preview"], [1024, "export"]] as const) {
  const t = performance.now();
  const { svg, stats } = renderSvgDetailed({ document: fx.document, layers: fx.layers, width: w, height: w, quality: q });
  const ms = performance.now() - t;
  writeFileSync(`out/fixture-${q}.svg`, svg);
  console.log(q, w, `${(stats.bytes / 1024).toFixed(0)}KB`, `${ms.toFixed(0)}ms`, JSON.stringify(stats));
  // rasterize for visual inspection
  const img = await loadImage(Buffer.from(svg));
  const c = createCanvas(w, w);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, w);
  writeFileSync(`out/fixture-${q}-svg.png`, c.toBuffer("image/png"));
  // physical A3@300dpi attribute check
  const physical = renderSvgDetailed({ document: fx.document, layers: fx.layers, width: 1024, height: 1024, quality: "export", physical: { page: "A3", dpi: 300 } });
  console.log("physical head:", physical.svg.slice(0, 260).replace(/\n/g, " "));
}
