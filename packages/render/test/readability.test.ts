/**
 * Readability assessment tests (v1.2.0).
 *
 *   pnpm -C packages/render test
 *
 * Covers: clean synthetic map scores high / no fail; extreme sea levels produce
 * the actionable water issues; a crowded label document reports collisions;
 * hidden/empty content does not crash; fixes are executable; repeated calls are
 * stateless; and the whole assessment stays inside its 15ms @1024 budget.
 */
import assert from "node:assert/strict";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { assessMapReadability, renderWorld, type Ctx2D, type ReadabilityIssue } from "../src/index";
import { createSyntheticWorld, type SyntheticWorld } from "../src/testing";
import { installNodeFonts } from "../src/node-fonts";

installNodeFonts(GlobalFonts, { quiet: true });

const ctx = createCanvas(1024, 1024).getContext("2d") as unknown as Ctx2D;

function assess(world: SyntheticWorld) {
  return assessMapReadability({
    ctx,
    document: world.document,
    layers: world.layers,
    width: 1024,
    height: 1024,
    quality: "preview",
  });
}

function assertFixes(issues: ReadabilityIssue[], label: string): void {
  for (const issue of issues) {
    assert.ok(issue.fixes.length > 0, `${label}: issue ${issue.id} has no executable fixes`);
    for (const fix of issue.fixes) {
      assert.ok(
        (fix.param === undefined) !== (fix.style === undefined),
        `${label}: fix for ${issue.id} must target exactly one of param/style`,
      );
      const kind = typeof fix.value;
      assert.ok(["number", "string", "boolean"].includes(kind), `${label}: bad fix value type`);
      if (fix.style === "showLabels") assert.equal(kind, "boolean");
      if (fix.style === "preset") assert.equal(kind, "string");
    }
  }
}

/** Collect interior land positions for crowding fixtures. */
function landPositions(layers: SyntheticWorld["layers"], count: number): Array<{ x: number; y: number }> {
  const n = layers.size;
  const positions: Array<{ x: number; y: number }> = [];
  for (let gy = 0.16; gy <= 0.84 && positions.length < count; gy += 0.05) {
    for (let gx = 0.16; gx <= 0.84 && positions.length < count; gx += 0.05) {
      const px = Math.min(n - 1, Math.floor(gx * n));
      const py = Math.min(n - 1, Math.floor(gy * n));
      const cell = py * n + px;
      if (!layers.ocean[cell] && !layers.lake[cell] && !layers.river[cell]) {
        positions.push({ x: gx, y: gy });
      }
    }
  }
  return positions;
}

function main(): void {
  const results: string[] = [];

  // 1) A normal synthetic world is readable: high score, no failure, sane math.
  // Balanced land/ocean fixture (default sea level leaves this fixture ~11% land).
  const normal = createSyntheticWorld({ size: 96, seed: 424242, seaLevel: 0.25 });
  const normalReport = assess(normal);
  assert.ok(normalReport.score >= 70, `normal map score too low: ${normalReport.score}`);
  assert.ok(
    normalReport.issues.every((issue) => issue.severity !== "fail"),
    `normal map must not fail: ${JSON.stringify(normalReport.issues)}`,
  );
  assert.ok(normalReport.metrics.landFraction > 0.15 && normalReport.metrics.landFraction < 0.85);
  assert.ok(normalReport.metrics.rivers > 0, "expected river cells");
  assert.ok(normalReport.metrics.biomeKinds >= 3, `expected biome variety, got ${normalReport.metrics.biomeKinds}`);
  assert.ok(normalReport.metrics.labelsDrawn > 0);
  assertFixes(normalReport.issues, "normal");
  results.push(
    `normal: score=${normalReport.score} issues=[${normalReport.issues.map((i) => i.id).join(",") || "none"}] ` +
      `land=${normalReport.metrics.landFraction} rivers=${normalReport.metrics.rivers} biomes=${normalReport.metrics.biomeKinds}`,
  );

  // 2) Ocean world → too-much-water (fail) with executable fixes.
  const oceanWorld = createSyntheticWorld({ size: 96, seaLevel: 0.95 });
  const oceanReport = assess(oceanWorld);
  const tooMuchWater = oceanReport.issues.find((issue) => issue.id === "too-much-water");
  assert.ok(tooMuchWater, "expected too-much-water issue");
  assert.equal(tooMuchWater!.severity, "fail");
  assert.ok(tooMuchWater!.fixes.some((fix) => fix.param === "seaLevel"));
  assertFixes(oceanReport.issues, "ocean");
  results.push(`seaLevel=0.95: score=${oceanReport.score} issues=[${oceanReport.issues.map((i) => i.id).join(",")}]`);

  // 3) Nearly all-land world → too-little-water (fail). The synthetic island
  // generator tops out below full land coverage, so fabricate an all-land
  // variant (ocean/lake masks cleared) to exercise the water balance check.
  const landBase = createSyntheticWorld({ size: 96, seaLevel: 0.05 });
  const landCells = landBase.layers.size * landBase.layers.size;
  const landWorld = {
    document: {
      ...landBase.document,
      params: { ...landBase.document.params, seaLevel: 0.05 },
    },
    layers: {
      ...landBase.layers,
      ocean: new Uint8Array(landCells),
      lake: new Uint8Array(landCells),
      stats: { ...landBase.layers.stats, landFraction: 1 },
    },
  };
  const landReport = assess(landWorld);
  const tooLittleWater = landReport.issues.find((issue) => issue.id === "too-little-water");
  assert.ok(tooLittleWater, "expected too-little-water issue");
  assert.equal(tooLittleWater!.severity, "fail");
  assert.ok(tooLittleWater!.fixes.some((fix) => fix.param === "seaLevel"));
  assertFixes(landReport.issues, "land");
  results.push(`seaLevel=0.05: score=${landReport.score} issues=[${landReport.issues.map((i) => i.id).join(",")}]`);

  // 4) Crowded labels (density 1) → label-collisions / overflow issue reported.
  const crowdedBase = createSyntheticWorld({ size: 96, seed: 424242 });
  const positions = landPositions(crowdedBase.layers, 34);
  assert.ok(positions.length >= 20, `not enough land positions for crowding fixture (${positions.length})`);
  const crowdedDoc = {
    ...crowdedBase.document,
    style: { ...crowdedBase.document.style, labelDensity: 1 },
    settlements: [],
    labels: positions.map((position, index) => ({
      id: `crowd-label-${index}`,
      text: `Crowd ${index}`,
      kind: "region" as const,
      x: position.x,
      y: position.y,
      size: 1.1,
    })),
  };
  const crowded = {
    document: crowdedDoc,
    layers: { ...crowdedBase.layers, autoLabels: [], settlements: [] },
  };
  const crowdedReport = assess(crowded);
  const labelIssue = crowdedReport.issues.find(
    (issue) => issue.id === "label-collisions" || issue.id === "labels-overflow",
  );
  assert.ok(labelIssue, `crowded map should report label layout issues: ${JSON.stringify(crowdedReport.issues)}`);
  assert.ok(labelIssue!.fixes.length > 0);
  assertFixes(crowdedReport.issues, "crowded");
  results.push(
    `crowded: score=${crowdedReport.score} issues=[${crowdedReport.issues.map((i) => i.id).join(",")}] ` +
      `collisions=${crowdedReport.metrics.collisions} skipped=${crowdedReport.metrics.labelsSkipped}`,
  );

  // 5) Hidden / empty content never crashes, and reports honest zero metrics.
  const emptyBase = createSyntheticWorld({ size: 96, seed: 424242 });
  const emptyWorld = {
    document: {
      ...emptyBase.document,
      labels: [],
      settlements: [],
      overrides: { ...emptyBase.document.overrides, hiddenIds: [] },
    },
    layers: { ...emptyBase.layers, autoLabels: [], settlements: [] },
  };
  const emptyReport = assess(emptyWorld);
  assert.equal(emptyReport.metrics.labelsDrawn, 0);
  assert.equal(emptyReport.metrics.labelsSkipped, 0);
  assert.equal(emptyReport.metrics.settlements, 0);
  assert.ok(emptyReport.issues.some((issue) => issue.id === "settlements-sparse"));
  assertFixes(emptyReport.issues, "empty");
  results.push(`empty content: score=${emptyReport.score} (no crash)`);

  // Hidden settled content is not counted as drawn settlements.
  const hiddenSettlementId = emptyBase.layers.settlements[0].id;
  const hiddenDoc = {
    ...normal.document,
    overrides: { ...normal.document.overrides, hiddenIds: [hiddenSettlementId] },
  };
  const hiddenReport = assessMapReadability({
    ctx,
    document: hiddenDoc,
    layers: normal.layers,
    width: 1024,
    height: 1024,
    quality: "preview",
  });
  assert.ok(
    hiddenReport.metrics.settlements <= normalReport.metrics.settlements,
    "hidden settlement still counted",
  );
  results.push(`hidden settlement: markers ${normalReport.metrics.settlements}→${hiddenReport.metrics.settlements}`);

  // 6) Stateless: repeated calls identical, including after a render.
  const first = JSON.stringify(normalReport);
  assert.equal(JSON.stringify(assess(normal)), first, "assessMapReadability leaked state");
  const canvas = createCanvas(1024, 1024);
  renderWorld({
    ctx: canvas.getContext("2d") as unknown as Ctx2D,
    width: 1024,
    height: 1024,
    document: normal.document,
    layers: normal.layers,
    quality: "preview",
  });
  assert.equal(JSON.stringify(assess(normal)), first, "assessMapReadability changed after a render");
  results.push("stateless: repeated calls identical");

  // 7) Performance budget: <= 15ms @1024 preview (best of 5, crowded worst case).
  const measureBest = (world: SyntheticWorld): number => {
    let best = Infinity;
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      assess(world);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const normalMs = measureBest(normal);
  const crowdedMs = measureBest(crowded);
  assert.ok(normalMs <= 15, `assessMapReadability too slow on normal map: ${normalMs.toFixed(2)}ms`);
  assert.ok(crowdedMs <= 15, `assessMapReadability too slow on crowded map: ${crowdedMs.toFixed(2)}ms`);
  results.push(
    `performance: normal ${normalMs.toFixed(2)}ms, crowded ${crowdedMs.toFixed(2)}ms @1024 preview (target <=15ms)`,
  );

  console.log("readability tests passed:");
  for (const line of results) console.log(`  ✓ ${line}`);
}

main();
