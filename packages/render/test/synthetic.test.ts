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
import { measureMapContent, renderWorld, type Ctx2D, type RenderStats } from "../src/index";
import { collectLabelDrawables, mergeMapContent } from "../src/labels";
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

  // 9) Location / place-name editing semantics: labels are merged by id (user
  //    and pinned entries win), hidden ids are filtered from generated *and*
  //    user sources, and optional `layers.hidden` is tolerated.
  {
    const base = createSyntheticWorld({ size: 96, seed: 424242 });
    const fullStyle = { ...base.document.style, labelDensity: 1 };
    const baseline = collectLabelDrawables(
      { ...base.document, style: fullStyle },
      base.layers,
      "preview",
      1,
    );
    const autoIds = base.layers.autoLabels.map((label) => label.id);
    assert.ok(autoIds.length >= 3, "fixture should expose several auto labels");

    const overriddenId = autoIds[0];
    const hiddenLabelId = autoIds[1];
    const layerHiddenLabelId = autoIds[autoIds.length - 1];
    const userOverride = {
      id: overriddenId,
      text: "Overridden Vale",
      kind: "region" as const,
      x: 0.77,
      y: 0.31,
      pinned: true,
    };
    const userAdded = {
      id: "user-label-brand-new",
      text: "Fresh Name",
      kind: "custom" as const,
      x: 0.63,
      y: 0.82,
    };
    const documentWithEdits = {
      ...base.document,
      style: fullStyle,
      overrides: { ...base.document.overrides, hiddenIds: [hiddenLabelId] },
      labels: [userOverride, userAdded],
    };
    // Newer core may also report hidden entries in layers.hidden (objects or ids).
    const layersWithHidden = {
      ...base.layers,
      hidden: [{ id: layerHiddenLabelId }],
    } as unknown as typeof base.layers;

    const merged = mergeMapContent(documentWithEdits, layersWithHidden);
    assert.equal(
      merged.labels.filter((label) => label.id === overriddenId).length,
      1,
      "same-id auto/user label must merge into a single entry",
    );
    const overridden = merged.labels.find((label) => label.id === overriddenId);
    assert.ok(overridden, "overridden label missing");
    assert.equal(overridden!.text, "Overridden Vale", "user label text must win");
    assert.equal(overridden!.x, 0.77, "user label position must win");
    assert.equal(overridden!.pinned, true);
    assert.ok(!merged.labels.some((label) => label.id === hiddenLabelId), "hiddenId label still present");
    assert.ok(
      !merged.labels.some((label) => label.id === layerHiddenLabelId),
      "layers.hidden label still present",
    );
    assert.ok(
      merged.labels.some((label) => label.id === "user-label-brand-new"),
      "user-added label missing from merge",
    );

    // Drawables: deduped ids are unique, no duplicate for the overridden id,
    // hidden labels gone and the newly added label drawn.
    const drawables = collectLabelDrawables(documentWithEdits, layersWithHidden, "preview", 1);
    const drawableIds = drawables.map((drawable) => drawable.id);
    assert.equal(new Set(drawableIds).size, drawableIds.length, "label drawables must not repeat ids");
    assert.equal(drawables.filter((drawable) => drawable.id === overriddenId).length, 1);
    assert.ok(!drawableIds.includes(hiddenLabelId), "hidden label was drawn");
    assert.ok(!drawableIds.includes(layerHiddenLabelId), "layers.hidden label was drawn");
    assert.ok(drawableIds.includes("user-label-brand-new"), "user-added label was not drawn");
    // Expected: all auto labels except the two hidden ones (the overridden id
    // still draws once) + the user-added label + the fixture settlements.
    const expectedDrawables = autoIds.length - 2 + 1 + base.layers.settlements.length;
    assert.equal(
      drawables.length,
      expectedDrawables,
      `expected ${expectedDrawables} drawables after hiding 2 labels and adding 1`,
    );
    results.push(
      `label merge: ${baseline.length}→${drawables.length} drawables (dedupe, 2 hidden, 1 added)`,
    );

    // Same scenario as core's merged-human output: the pinned user label is
    // already present in layers.autoLabels *and* document.labels → one entry.
    const coreMergedLayers = {
      ...base.layers,
      autoLabels: [...base.layers.autoLabels, { ...userOverride }],
    };
    const coreMerged = mergeMapContent({ ...base.document, labels: [userOverride] }, coreMergedLayers);
    assert.equal(
      coreMerged.labels.filter((label) => label.id === overriddenId).length,
      1,
      "core-merged pinned label drawn twice",
    );

    // Hiding a user / pinned label must suppress it as well.
    const hiddenUserLabel = mergeMapContent(
      {
        ...documentWithEdits,
        overrides: { ...documentWithEdits.overrides, hiddenIds: [overriddenId, hiddenLabelId] },
      },
      base.layers,
    );
    assert.ok(
      !hiddenUserLabel.labels.some((label) => label.id === overriddenId),
      "hiddenIds must also suppress user labels",
    );

    // Settlements: user override wins, hiddenIds filtered from both sources
    // (including one re-sent from document.settlements), layers.hidden optional.
    const baseSettlements = base.layers.settlements;
    assert.ok(baseSettlements.length >= 3, "fixture should expose settlements");
    const hiddenSettlementId = baseSettlements[1].id;
    const overriddenSettlementId = baseSettlements[0].id;
    const pinnedSettlement = {
      ...baseSettlements[0],
      name: "Aurelian Prime",
      x: 0.61,
      y: 0.47,
      pinned: true,
    };
    const resurrectedHidden = { ...baseSettlements[1], name: "Should Never Appear" };
    const editedDocument = {
      ...base.document,
      style: fullStyle,
      overrides: { ...base.document.overrides, hiddenIds: [hiddenSettlementId] },
      settlements: [pinnedSettlement, resurrectedHidden],
    };
    const mergedSettlements = mergeMapContent(editedDocument, base.layers); // layers.hidden absent
    assert.equal(
      mergedSettlements.settlements.length,
      baseSettlements.length - 1,
      "hidden settlement must be removed from the merged settlement list",
    );
    const pinnedMerged = mergedSettlements.settlements.find(
      (settlement) => settlement.id === overriddenSettlementId,
    );
    assert.ok(pinnedMerged, "pinned settlement missing");
    assert.equal(pinnedMerged!.name, "Aurelian Prime", "pinned settlement name must win");
    assert.equal(pinnedMerged!.x, 0.61, "pinned settlement position must win");
    assert.equal(pinnedMerged!.pinned, true);
    assert.ok(
      !mergedSettlements.settlements.some((settlement) => settlement.id === hiddenSettlementId),
      "hidden settlement was resurrected by document.settlements",
    );

    const editedShot = render({ document: editedDocument, layers: base.layers }, 1024, 1024);
    assertPng(editedShot.png, "edited document labels");
    assert.equal(
      editedShot.stats.settlements,
      baseSettlements.length - 1,
      "hidden settlement still counted as a drawn marker",
    );
    const pinnedDrawables = collectLabelDrawables(editedDocument, base.layers, "preview", 1);
    const pinnedDrawable = pinnedDrawables.find((drawable) => drawable.id === overriddenSettlementId);
    assert.ok(pinnedDrawable, "pinned settlement label drawable missing");
    assert.equal(pinnedDrawable!.text, "Aurelian Prime");
    assert.equal(pinnedDrawable!.x, 0.61);
    results.push(
      `settlement merge: hidden removed, pinned override wins (markers=${editedShot.stats.settlements})`,
    );
  }

  // 10) Hit-testing layout API (`measureMapContent`) — same-source geometry.
  {
    const world = createSyntheticWorld({ size: 96, seed: 424242 });
    const ctx = createCanvas(1024, 1024).getContext("2d") as unknown as Ctx2D;
    const measure = (document = world.document, layers = world.layers, quality: "preview" | "export" = "preview") =>
      measureMapContent({ ctx, document, layers, width: 1024, height: 1024, quality });
    /** True when a small neighbourhood around (u,v) is dry, river-free land. */
    const interiorLand = (u: number, v: number, radiusU = 0.07, radiusV = 0.035): boolean => {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const cu = u + dx * radiusU;
          const cv = v + dy * radiusV;
          if (cu < 0 || cu > 1 || cv < 0 || cv > 1) return false;
          const cell =
            Math.min(seaSize - 1, Math.floor(cv * seaSize)) * seaSize +
            Math.min(seaSize - 1, Math.floor(cu * seaSize));
          if (world.layers.ocean[cell] || world.layers.lake[cell] || world.layers.river[cell]) {
            return false;
          }
        }
      }
      return true;
    };

    // 10a) Consistency with the painted result / RenderStats counters.
    const shot = render(world, 1024, 1024, "preview");
    const measured = measure();
    const measuredLabels = measured.filter((entry) => entry.entity === "label");
    const measuredSettlements = measured.filter((entry) => entry.entity === "settlement");
    assert.equal(measuredSettlements.length, shot.stats.settlements, "settlement count mismatch");
    assert.equal(
      measuredLabels.length,
      shot.stats.labelsDrawn - shot.stats.settlementNames,
      "plain label count mismatch",
    );
    assert.equal(
      measured.length,
      shot.stats.labelsDrawn - shot.stats.settlementNames + shot.stats.settlements,
      "measured total must match the drawn label + marker count",
    );
    assert.deepEqual(
      measured.map((entry) => entry.drawOrder),
      measured.map((_, index) => index),
      "drawOrder must be contiguous and ascending (paint order)",
    );
    for (const entry of measured) {
      assert.ok(entry.text.length > 0, `empty text for ${entry.id}`);
      assert.ok(Number.isFinite(entry.x) && Number.isFinite(entry.y), `bad box for ${entry.id}`);
      assert.ok(entry.width > 0 && entry.height > 0, `empty box for ${entry.id}`);
      assert.ok(Math.abs(entry.centerX - (entry.x + entry.width / 2)) < 1e-6);
      assert.ok(Math.abs(entry.centerY - (entry.y + entry.height / 2)) < 1e-6);
      assert.ok(entry.x >= -0.001 && entry.y >= -0.001, `${entry.id} outside canvas (top-left)`);
      assert.ok(
        entry.x + entry.width <= 1024.001 && entry.y + entry.height <= 1024.001,
        `${entry.id} outside canvas (bottom-right)`,
      );
    }
    results.push(
      `measure consistency: ${measuredLabels.length} labels + ${measuredSettlements.length} settlements == RenderStats`,
    );

    // 10b) Hidden entries never reach the hit-test boxes.
    const hiddenLabelId = world.layers.autoLabels[1]?.id;
    const hiddenSettlementId = world.layers.settlements[1]?.id;
    assert.ok(hiddenLabelId && hiddenSettlementId, "fixture ids missing");
    const hiddenDoc = {
      ...world.document,
      overrides: {
        ...world.document.overrides,
        hiddenIds: [hiddenLabelId!, hiddenSettlementId!],
      },
    };
    const hiddenMeasured = measure(hiddenDoc);
    assert.ok(
      !hiddenMeasured.some((entry) => entry.id === hiddenLabelId),
      "hidden label returned by measureMapContent",
    );
    assert.ok(
      !hiddenMeasured.some((entry) => entry.id === hiddenSettlementId && entry.entity === "settlement"),
      "hidden settlement returned by measureMapContent",
    );
    results.push("measure hidden filter: hidden label/settlement omitted");

    // 10c) Sea labels are searched into open water and stay inside the frame.
    const seaMeasured = measured.find((entry) => entry.id === "l-water-1");
    assert.ok(seaMeasured, "sea label missing from measured content");
    assert.ok(
      seaMeasured!.x >= 0 && seaMeasured!.y >= 0 && seaMeasured!.x + seaMeasured!.width <= 1024,
      "sea label outside the canvas",
    );
    const centerU = seaMeasured!.centerX / 1024;
    const centerV = seaMeasured!.centerY / 1024;
    const seaSize = world.layers.size;
    const seaCellX = Math.min(seaSize - 1, Math.floor(centerU * seaSize));
    const seaCellY = Math.min(seaSize - 1, Math.floor(centerV * seaSize));
    assert.equal(
      world.layers.ocean[seaCellY * seaSize + seaCellX],
      1,
      "sea label centre is not over ocean",
    );
    results.push(`measure sea label: (${seaMeasured!.centerX.toFixed(0)}, ${seaMeasured!.centerY.toFixed(0)}) in open sea`);

    // 10d) CJK and Latin labels both get positive measurable boxes.
    const emptyLayers = { ...world.layers, autoLabels: [], settlements: [] };
    // Pick two deterministic land, non-river positions for the labels.
    const landPositions: Array<{ x: number; y: number }> = [];
    for (let gy = 0.3; gy <= 0.75 && landPositions.length < 2; gy += 0.05) {
      for (let gx = 0.25; gx <= 0.75 && landPositions.length < 2; gx += 0.05) {
        const farEnough = landPositions.every(
          (existing) => Math.hypot(existing.x - gx, existing.y - gy) > 0.25,
        );
        if (farEnough && interiorLand(gx, gy)) {
          landPositions.push({ x: gx, y: gy });
        }
      }
    }
    assert.equal(landPositions.length, 2, "could not find two land positions in fixture");
    const i18nDoc = {
      ...world.document,
      settlements: [],
      labels: [
        { id: "measure-cjk", text: "苍茫海域", kind: "region" as const, x: landPositions[0].x, y: landPositions[0].y, size: 1 },
        { id: "measure-latin", text: "Fresh Latin", kind: "custom" as const, x: landPositions[1].x, y: landPositions[1].y, size: 1 },
      ],
    };
    const i18n = measure(i18nDoc, emptyLayers);
    const cjk = i18n.find((entry) => entry.id === "measure-cjk");
    const latin = i18n.find((entry) => entry.id === "measure-latin");
    assert.ok(cjk && latin, "i18n labels missing from measured content");
    assert.ok(cjk!.width > 0 && cjk!.height > 0, "CJK label has empty box");
    assert.ok(latin!.width > 0 && latin!.height > 0, "Latin label has empty box");
    results.push(`measure i18n: CJK ${cjk!.width.toFixed(0)}x${cjk!.height.toFixed(0)}px, Latin ${latin!.width.toFixed(0)}x${latin!.height.toFixed(0)}px`);

    // 10e) Quality tiers really change the layout (export draws more names).
    const candidates: Array<{ x: number; y: number }> = [];
    for (let gy = 0.12; gy <= 0.88 && candidates.length < 40; gy += 0.04) {
      for (let gx = 0.12; gx <= 0.88 && candidates.length < 40; gx += 0.04) {
        const cell =
          Math.min(seaSize - 1, Math.floor(gy * seaSize)) * seaSize +
          Math.min(seaSize - 1, Math.floor(gx * seaSize));
        if (
          !world.layers.ocean[cell] &&
          !world.layers.lake[cell] &&
          !world.layers.river[cell]
        ) {
          candidates.push({ x: gx, y: gy });
        }
      }
    }
    const manyDoc = {
      ...world.document,
      settlements: [],
      labels: candidates.map((position, index) => ({
        id: `quality-label-${index}`,
        text: `L${index % 10}`,
        kind: "custom" as const,
        x: position.x,
        y: position.y,
        size: 0.5,
      })),
    };
    const previewMany = measure(manyDoc, emptyLayers, "preview");
    const exportMany = measure(manyDoc, emptyLayers, "export");
    assert.ok(previewMany.length > 0, "quality fixture measured no labels in preview");
    assert.ok(
      exportMany.length > previewMany.length,
      `export (${exportMany.length}) should lay out more labels than preview (${previewMany.length})`,
    );
    results.push(`measure quality: preview ${previewMany.length} labels, export ${exportMany.length}`);

    // 10f) Repeated calls are stateless / deterministic.
    const first = JSON.stringify(measure());
    void render(world, 512, 512, "preview");
    const second = JSON.stringify(measure());
    void measure(world.document, world.layers, "export");
    const third = JSON.stringify(measure());
    assert.equal(first, second, "measureMapContent leaked state between calls");
    assert.equal(first, third, "measureMapContent leaked state after an export-quality call");
    results.push("measure state: repeated calls identical");

    // 10g) Performance budget: <= 8ms for a 1024 preview layout (local).
    const manyLayers = emptyLayers;
    for (let i = 0; i < 3; i += 1) measure(manyDoc, manyLayers, "preview");
    let bestMs = Infinity;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      measure(manyDoc, manyLayers, "preview");
      bestMs = Math.min(bestMs, performance.now() - start);
    }
    assert.ok(bestMs <= 8, `measureMapContent too slow: ${bestMs.toFixed(2)}ms > 8ms`);
    results.push(`measure performance: ${bestMs.toFixed(2)}ms @1024 preview (target <= 8ms)`);
  }

  // 11) Optional additive `style.biomeTint` (0..1) controls the biome wash
  //     weight; the renderer reads it structurally so RenderStyle stays as-is.
  {
    const base = createSyntheticWorld({ size: 96, seed: 424242 });
    const withTint = (value: number) => ({
      ...base,
      document: {
        ...base.document,
        style: { ...base.document.style, biomeTint: value },
      },
    });
    const strong = render(withTint(0.95), 512, 512);
    const soft = render(withTint(0.2), 512, 512);
    assert.ok(!strong.png.equals(soft.png), "style.biomeTint has no effect on the biome wash");
    const plain = render(base, 512, 512);
    const explicitDefault = render(withTint(0.55), 512, 512);
    assert.ok(
      plain.png.equals(explicitDefault.png),
      "default biome tint weight drifted from the documented 0.55",
    );
    assertPng(strong.png, "biomeTint strong");
    results.push("biomeTint style override: 0.2 vs 0.95 differ, default == 0.55");
  }

  void pixelStats;
  console.log("renderer synthetic tests passed:");
  for (const line of results) console.log(`  ✓ ${line}`);
}

main().catch((error) => {
  console.error("renderer synthetic tests FAILED:", error);
  process.exit(1);
});
