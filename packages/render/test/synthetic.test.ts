/**
 * Renderer robustness tests (no vitest dependency needed):
 *
 *   pnpm -C packages/render test
 *
 * Uses the synthetic fixture (island + lake + river + towns + labels) so the
 * renderer is verified independently of the generator pipeline: arbitrary
 * output sizes, both presets, every style switch, determinism and CJK labels.
 */
import assert from "node:assert/strict";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createSyntheticWorld, type SyntheticWorld } from "../src/testing";
import { renderWorld, type Ctx2D, type RenderStats } from "../src/index";
import { installNodeFonts } from "../src/node-fonts";

installNodeFonts(GlobalFonts, { quiet: true });

interface Shot {
  png: Buffer;
  stats: RenderStats;
}

function render(
  world: SyntheticWorld,
  width: number,
  height: number,
  quality: "preview" | "export" = "preview",
): Shot {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const stats = renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width,
    height,
    document: world.document,
    layers: world.layers,
    quality,
  });
  return { png: canvas.toBuffer("image/png"), stats };
}

function pixelStats(png: Buffer): { min: number; max: number; distinct: number } {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(64, 64);
  // Cheap blankness proxy: decode via drawImage is not available synchronously;
  // instead use the RGBA data path through getImageData after putImageData test.
  void img;
  void png;
  return { min: 0, max: 255, distinct: 2 };
}

/** Detect a non-blank image by loading it back through the canvas decoder. */
async function isNonBlank(png: Buffer): Promise<boolean> {
  const { loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = (data[i] * 3 + data[i + 1] * 5 + data[i + 2]) >> 3;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
  }
  return max - min > 24;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertPng(png: Buffer, label: string): void {
  assert.ok(png.length > 2048, `${label}: PNG is suspiciously small (${png.length} bytes)`);
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), `${label}: not a PNG`);
}

async function main(): Promise<void> {
  const results: string[] = [];

  // 1) Arbitrary output sizes (square + non-square + tiny + preview/export).
  const sizes: Array<[number, number]> = [
    [256, 256],
    [320, 200],
    [900, 300],
    [512, 512],
    [1024, 1024],
  ];
  const world = createSyntheticWorld({ size: 96, seed: 424242 });
  for (const [w, h] of sizes) {
    const shot = render(world, w, h, w * h > 600000 ? "export" : "preview");
    assertPng(shot.png, `size ${w}x${h}`);
    assert.ok(shot.stats.coastLines >= 1, `size ${w}x${h}: expected a coastline`);
    assert.ok(shot.stats.labelsDrawn >= 0, `size ${w}x${h}: label counter`);
    assert.ok(shot.stats.totalMs < 30000, `size ${w}x${h}: render took too long`);
    results.push(`size ${w}x${h}: ${shot.stats.totalMs.toFixed(1)}ms, ${(shot.png.length / 1024).toFixed(0)}KB`);
  }

  // 2) Presets must actually change the image (regression: identical presets).
  {
    const classic = render(createSyntheticWorld({ size: 96, preset: "parchment-classic" }), 512, 512);
    const aged = render(createSyntheticWorld({ size: 96, preset: "aged-ink" }), 512, 512);
    assert.ok(!classic.png.equals(aged.png), "parchment-classic and aged-ink produced identical pixels");
    results.push(`presets differ: classic=${classic.png.length}B aged=${aged.png.length}B`);
  }

  // 3) Determinism: identical inputs → byte-identical output.
  {
    const a = render(createSyntheticWorld({ size: 96, seed: 7 }), 512, 512);
    const b = render(createSyntheticWorld({ size: 96, seed: 7 }), 512, 512);
    assert.ok(a.png.equals(b.png), "renderer is not deterministic for identical input");
    results.push("determinism: identical PNG bytes");
  }

  // 4) Every RenderStyle switch off / on must not crash and must change output.
  {
    const base = createSyntheticWorld({ size: 96 });
    const allOff = {
      ...base.document,
      style: {
        ...base.document.style,
        showLabels: false,
        showRivers: false,
        showGraticule: false,
        showBorder: false,
        showCompass: false,
        showLegend: false,
        paperTexture: 0,
        hillshadeStrength: 0,
        coastHatching: 0,
        labelDensity: 0,
      },
    };
    const off = render({ ...base, document: allOff }, 640, 640);
    assertPng(off.png, "all style switches off");
    const allOn = {
      ...base.document,
      style: {
        ...base.document.style,
        showLabels: true,
        showRivers: true,
        showGraticule: true,
        showBorder: true,
        showCompass: true,
        showLegend: true,
        paperTexture: 1,
        hillshadeStrength: 1,
        coastHatching: 1,
        labelDensity: 1,
      },
    };
    const on = render({ ...base, document: allOn }, 640, 640);
    assertPng(on.png, "all style switches on");
    assert.ok(!off.png.equals(on.png), "style switches have no effect on the image");
    results.push(`style switches: off/on render differs`);
  }

  // 5) Empty labels / settlements must be safe (generator may not emit them yet).
  {
    const bare = createSyntheticWorld({ size: 96 });
    const emptyDoc = { ...bare.document, labels: [], settlements: [] };
    const layers = { ...bare.layers, autoLabels: [], settlements: [] };
    const shot = render({ document: emptyDoc, layers }, 768, 768);
    assertPng(shot.png, "no labels");
    assert.equal(shot.stats.labelsDrawn, 0, "expected no labels");
    results.push("empty labels/settlements: safe");
  }

  // 6) CJK labels exercise the CJK font fallback path.
  {
    const cjk = createSyntheticWorld({ size: 96 });
    const doc = {
      ...cjk.document,
      labels: [
        ...cjk.document.labels,
        { id: "cjk-1", text: "苍茫海域", kind: "region" as const, x: 0.5, y: 0.2, size: 1.2 },
        { id: "cjk-2", text: "月长溪河", kind: "water" as const, x: 0.4, y: 0.62, size: 1 },
      ],
    };
    const shot = render({ ...cjk, document: doc }, 1024, 1024);
    assertPng(shot.png, "CJK labels");
    assert.ok(shot.stats.labelsDrawn >= 1, "CJK labels were all skipped");
    results.push(`CJK labels: ${shot.stats.labelsDrawn} drawn, font ${shot.stats.fontFamily}`);
  }

  // 7) Tiny simulation grid (extreme case) must not crash.
  {
    const tiny = createSyntheticWorld({ size: 24, seed: 3 });
    const shot = render(tiny, 256, 256);
    assertPng(shot.png, "tiny grid");
    results.push("tiny 24² simulation grid: safe");
  }

  // 8) Output is not blank (decode the 1024 preview back).
  {
    const shot = render(createSyntheticWorld({ size: 96 }), 1024, 1024);
    assert.ok(await isNonBlank(shot.png), "rendered map looks blank");
    const s = shot.stats;
    assert.ok(s.mountainGlyphs + s.forestGlyphs > 0, "expected relief glyphs on the fixture");
    assert.ok(s.riverCount > 0, "expected rivers on the fixture");
    results.push(`not blank: ${s.labelsDrawn} labels, ${s.riverCount} rivers, ${s.mountainGlyphs} peaks`);
  }

  void pixelStats;
  console.log("renderer synthetic tests passed:");
  for (const line of results) console.log(`  ✓ ${line}`);
}

main().catch((error) => {
  console.error("renderer synthetic tests FAILED:", error);
  process.exit(1);
});
