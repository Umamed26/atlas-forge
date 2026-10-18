/**
 * Self-test for the tolerant visual regression judge (scripts/visual-lib.ts).
 *
 *   tsx scripts/visual-selftest.ts
 *
 * Proves the CI fix catches real regressions while tolerating environment-level
 * anti-aliasing / font-fallback noise:
 *   - ±6 uniform channel noise   → PASS (simulates Skia/font AA differences)
 *   - global brightness +3       → PASS (minor rendering/calibration drift)
 *   - global brightness +8       → FAIL (visible exposure change)
 *   - 2px translation            → FAIL (layout shift)
 *   - local label-colour patch   → FAIL (ink/label change)
 * Also reports the metrics for every committed baseline.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  BASELINE_DIR,
  BASELINE_LATIN_TITLES,
  CHANNEL_DELTA_TOLERANCE,
  DOWNSAMPLED_DELTA_THRESHOLD,
  STRUCTURAL_DIFF_THRESHOLD,
  comparePngStructural,
  loadManifest,
  metricsPass,
  type VisualDiffMetrics,
} from "./visual-lib";

function hash(x: number, y: number, c: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(c, 2654435761);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

/** ±6 deterministic per-channel noise (simulates platform AA differences). */
function uniformNoise6(data: Uint8ClampedArray, width: number): number {
  let changed = 0;
  for (let p = 0; p < data.length / 4; p += 1) {
    const x = p % width;
    const y = Math.floor(p / width);
    for (let c = 0; c < 3; c += 1) {
      const delta = (hash(x, y, c) % 13) - 6;
      const value = data[p * 4 + c] + delta;
      data[p * 4 + c] = value < 0 ? 0 : value > 255 ? 255 : value;
    }
    changed += 1;
  }
  return changed;
}

function brightness(delta: number): Transform {
  return (data) => {
    let changed = 0;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const value = data[i + c] + delta;
        data[i + c] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
      changed += 1;
    }
    return changed;
  };
}

async function encodeTransformed(
  png: Buffer,
  transform: (data: Uint8ClampedArray, width: number, height: number) => number,
): Promise<{ png: Buffer; changed: number }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, image.width, image.height);
  const changed = transform(imageData.data, image.width, image.height);
  ctx.putImageData(imageData, 0, 0);
  return { png: canvas.toBuffer("image/png"), changed };
}

async function shift2px(png: Buffer): Promise<{ png: Buffer; changed: number }> {
  const image = await loadImage(png);
  const width = image.width;
  const height = image.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 2, 0);
  ctx.drawImage(image, 2 - width, 0); // wrap the 2 columns that fell off
  return { png: canvas.toBuffer("image/png"), changed: Math.round(width * height * 0.01) };
}

/** Recolour a label-sized patch of dark ink to a strong accent colour. */
function labelColourPatch(data: Uint8ClampedArray, width: number, height: number): number {
  let changed = 0;
  const x0 = Math.floor(width * 0.25);
  const x1 = Math.floor(width * 0.62);
  const y0 = Math.floor(height * 0.25);
  const y1 = Math.floor(height * 0.36);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      const luma = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
      if (luma < 190) {
        data[i] = 176;
        data[i + 1] = 38;
        data[i + 2] = 26;
        changed += 1;
      }
    }
  }
  return changed;
}

function fmt(metrics: VisualDiffMetrics): string {
  return (
    `struct=${(metrics.structuralDiff * 100).toFixed(4)}%  ` +
    `maxΔ=${metrics.maxChannelDelta}  ` +
    `dsΔ=${metrics.downsampledMaxDelta.toFixed(2)}`
  );
}

async function main(): Promise<void> {
  const files = readdirSync(BASELINE_DIR)
    .filter((file) => file.endsWith(".png"))
    .sort();
  if (files.length === 0) {
    console.error("no baseline images found — run pnpm qa:baseline first");
    process.exit(1);
  }

  console.log(
    `[selftest] tolerant judge: pixel Δ>${CHANNEL_DELTA_TOLERANCE}, structural ≤${(STRUCTURAL_DIFF_THRESHOLD * 100).toFixed(2)}%, ` +
      `64×64 mean Δ≤${DOWNSAMPLED_DELTA_THRESHOLD}`,
  );

  const cases: Array<{ name: string; expectPass: boolean; make: (png: Buffer) => Promise<{ png: Buffer; changed: number }> }> = [
    {
      name: "uniform ±6 noise (simulated AA)",
      expectPass: true,
      make: (png) => encodeTransformed(png, (data, width) => uniformNoise6(data, width)),
    },
    {
      name: "global brightness +3",
      expectPass: true,
      make: (png) => encodeTransformed(png, brightness(3)),
    },
    {
      name: "global brightness +8",
      expectPass: false,
      make: (png) => encodeTransformed(png, brightness(8)),
    },
    {
      name: "shift 2px",
      expectPass: false,
      make: (png) => shift2px(png),
    },
    {
      name: "label colour patch",
      expectPass: false,
      make: (png) => encodeTransformed(png, labelColourPatch),
    },
  ];

  let failures = 0;
  for (const testCase of cases) {
    let passCount = 0;
    let example = "";
    let exampleChanged = 0;
    for (const file of files) {
      const baseline = readFileSync(join(BASELINE_DIR, file));
      const variant = await testCase.make(baseline);
      const metrics = await comparePngStructural(baseline, variant.png);
      const passed = metricsPass(metrics);
      if (passed === testCase.expectPass) passCount += 1;
      if (!example) {
        example = fmt(metrics);
        exampleChanged = variant.changed;
      }
    }
    const ok = passCount === files.length;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "✓" : "✗"} ${testCase.name.padEnd(28)} expected ${testCase.expectPass ? "PASS" : "FAIL"} · ` +
        `${passCount}/${files.length} · e.g. ${example} (changed ${exampleChanged}px)`,
    );
  }

  // Existing local baselines must pass with zero changes.
  {
    let passCount = 0;
    for (const file of files) {
      const png = readFileSync(join(BASELINE_DIR, file));
      const metrics = await comparePngStructural(png, png);
      if (metricsPass(metrics)) passCount += 1;
    }
    const ok = passCount === files.length;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "✓" : "✗"} untouched local baselines      ${passCount}/${files.length} PASS`);
  }

  // Baselines must stay font-independent: no CJK title may leak into the
  // compared plates, otherwise CI runners without CJK fallback fonts render
  // different glyphs (this was the v0.4.0 CI failure).
  {
    const manifest = loadManifest();
    const cjk = /[\u3400-\u9fff]/;
    const nonAsciiTitles = Object.entries(BASELINE_LATIN_TITLES).filter(([, title]) => !/^[\x20-\x7e]+$/.test(title));
    const cjkScenarioNames = manifest
      ? manifest.entries.filter((entry) => cjk.test(entry.scenarioName)).map((entry) => entry.id)
      : ["manifest-missing"];
    const latinOnly = manifest?.fontScope === "latin-only";
    const ok = latinOnly && nonAsciiTitles.length === 0 && cjkScenarioNames.length === 0;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? "✓" : "✗"} baseline manifest latin-only      ` +
        `fontScope=${manifest?.fontScope ?? "missing"} · CJK scenarioNames=${cjkScenarioNames.length}` +
        `${nonAsciiTitles.length > 0 ? ` · non-ASCII titles=${nonAsciiTitles.join(",")}` : ""}`,
    );
  }

  if (failures > 0) {
    console.error(`[selftest] FAILED: ${failures} expectation(s) not met`);
    process.exit(1);
  }
  console.log(`[selftest] PASS — ${cases.length} scenarios × ${files.length} baselines + untouched baselines all as expected`);
}

main().catch((error) => {
  console.error("[selftest] error:", error);
  process.exit(1);
});
