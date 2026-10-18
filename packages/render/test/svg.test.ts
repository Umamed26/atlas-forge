/**
 * Vector export tests (v0.5).
 *
 *   pnpm -C packages/render test
 *
 * The SVG must be standalone, deterministic, XML-safe, print-size aware, and
 * carry the same content as the raster renderer (layer groups + statistics).
 */
import assert from "node:assert/strict";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createDefaultDocument, type WorldDocument } from "@atlas/core";

import { renderSvg, renderSvgDetailed } from "../src/svg";
import { renderWorld, type Ctx2D } from "../src/index";
import { defaultDocumentForRenderTests } from "../src/testing";
import { installNodeFonts } from "../src/node-fonts";

installNodeFonts(GlobalFonts, { quiet: true });

function pass(name: string): void {
  console.log(`  ✓ ${name}`);
}

// 1) standalone structure
{
  const { document, layers } = defaultDocumentForRenderTests(512);
  const svg = renderSvg({ document, layers, width: 512, height: 512 });
  assert.ok(svg.startsWith("<svg") || svg.startsWith("<?xml"), "svg must start with a tag");
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), "missing xmlns");
  assert.ok(svg.includes("viewBox="), "missing viewBox");
  assert.ok(svg.includes('<g id="coastlines"'), "missing coastline group");
  assert.ok(svg.includes('<g id="rivers"'), "missing rivers group");
  assert.ok(svg.includes('<g id="labels"'), "missing labels group");
  assert.ok(svg.trimEnd().endsWith("</svg>"), "unterminated svg");
  pass("standalone svg with coastline/rivers/labels groups");
}

// 2) determinism
{
  const { document, layers } = defaultDocumentForRenderTests(512);
  const a = renderSvg({ document, layers, width: 512, height: 512 });
  const b = renderSvg({ document, layers, width: 512, height: 512 });
  assert.equal(a, b, "svg output is not deterministic");
  pass("identical inputs produce byte-identical svg");
}

// 3) XML escaping
{
  const { document, layers } = defaultDocumentForRenderTests(512);
  // The cartouche title is always drawn, so it is the reliable place to assert
  // XML escaping (arbitrary labels can be skipped by the collision layout).
  const withMarkup: WorldDocument = {
    ...document,
    name: 'Ampersand & <Angle> "Quote"',
    style: { ...document.style, title: 'Ampersand & <Angle> "Quote"' },
  };
  const svg = renderSvg({ document: withMarkup, layers, width: 512, height: 512 });
  assert.ok(svg.includes("&amp;"), "ampersand not escaped");
  assert.ok(svg.includes("&lt;Angle&gt;"), "angle brackets not escaped");
  assert.ok(!svg.includes("<Angle>"), "raw markup leaked into the document");
  pass("label text is XML-escaped");
}

// 4) physical print size
{
  const { document, layers } = defaultDocumentForRenderTests(512);
  const svg = renderSvg({
    document,
    layers,
    width: 1024,
    height: 1024,
    physical: { dpi: 300, widthMm: 420, heightMm: 297 },
  });
  // Physical size is expressed as print pixels + data attributes so viewers
  // that ignore mm still lay the page out correctly.
  assert.ok(svg.includes('data-physical-mm="420x297"'), "missing physical mm size");
  assert.ok(svg.includes('data-dpi="300"'), "missing dpi");
  assert.ok(svg.includes('width="4961"'), "A3@300dpi width not applied");
  pass("A3 @ 300dpi physical size is emitted");
}

// 5) content parity with the raster renderer
{
  const { document, layers } = defaultDocumentForRenderTests(512);
  const detailed = renderSvgDetailed({ document, layers, width: 512, height: 512 });
  const canvas = createCanvas(512, 512);
  const stats = renderWorld({
    ctx: canvas.getContext("2d") as unknown as Ctx2D,
    width: 512,
    height: 512,
    document,
    layers,
    quality: "preview",
  });
  assert.ok(detailed.stats.riverPaths > 0, "no river paths in svg");
  assert.ok(detailed.stats.coastLines >= stats.coastLines, "coastline count below raster");
  assert.equal(detailed.stats.labels, stats.labelsDrawn, "label count differs from raster");
  assert.ok(detailed.stats.bytes > 10_000, "svg suspiciously small");
  pass(`content parity: rivers=${detailed.stats.riverPaths} labels=${detailed.stats.labels} bytes=${detailed.stats.bytes}`);
}

// 6) size + time budget at 1024
{
  const { document, layers } = defaultDocumentForRenderTests(1024);
  const startedAt = performance.now();
  const detailed = renderSvgDetailed({ document, layers, width: 1024, height: 1024 });
  const elapsed = performance.now() - startedAt;
  assert.ok(detailed.stats.bytes < 2_000_000, `svg too large: ${detailed.stats.bytes}`);
  assert.ok(elapsed < 1_500, `svg export too slow: ${elapsed.toFixed(0)}ms`);
  pass(`1024 svg budget: ${Math.round(detailed.stats.bytes / 1024)}KB, ${elapsed.toFixed(0)}ms`);
}

// 7) empty world
{
  const base = defaultDocumentForRenderTests(64);
  const document = createDefaultDocument({ seed: 1 });
  const svg = renderSvg({
    document,
    layers: {
      ...base.layers,
      settlements: [],
      autoLabels: [],
      river: new Uint8Array(64 * 64),
      lake: new Uint8Array(64 * 64),
      biome: new Uint8Array(64 * 64),
    },
    width: 64,
    height: 64,
  });
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  pass("empty world still produces a closed svg");
}

console.log("svg export tests passed");
