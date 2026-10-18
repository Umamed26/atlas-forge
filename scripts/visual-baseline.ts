/**
 * Generate the visual regression baseline set.
 *
 * The gate is decoupled from the generation algorithm: baselines are rendered
 * from a fixed code-generated fixture (continent + archipelagos + mountains +
 * river network + lakes + towns), never from the real pipeline. Matrix =
 * 1 fixture × 2 presets (parchment-classic / aged-ink) × 2 qualities
 * (preview 512 / export 1024). Everything is latin-only (bundled EB Garamond),
 * so terrain/hydrology upgrades cannot invalidate the gate.
 *
 *   tsx scripts/visual-baseline.ts              # rebuild fixture baselines
 *   tsx scripts/visual-baseline.ts --cards-only # refresh product cards only
 *   pnpm qa:baseline                            # same as first form
 *
 * Outputs:
 *   packages/render/test/baselines/fixture-<preset>-<quality>.png   512/1024 plates
 *   packages/render/test/baselines/thumbs/<id>.png                  256² thumbnails
 *   packages/render/test/baselines/manifest.json                    sha/fixtureVersion/fontScope
 *   apps/web/public/presets/<scenario>.png                          product cards (--cards-only)
 */
import {
  generateBaselines,
  generatePresetCards,
  MANIFEST_PATH,
  PRESET_THUMB_DIR,
  MATRIX,
  VISUAL_FIXTURE_TITLE,
  VISUAL_FIXTURE_VERSION,
} from "./visual-lib";

const args = new Set(process.argv.slice(2));

if (args.has("--cards-only")) {
  console.log("[visual] --cards-only: refreshing product preset cards (Chinese titles) only");
  const cards = generatePresetCards();
  console.log(`[visual] cards: ${PRESET_THUMB_DIR}/<scenario>.png`);
  console.log(
    `[visual] wrote ${cards.paths.length} cards, ${(cards.totalBytes / 1024).toFixed(0)}KB in ` +
      `${(cards.totalMs / 1000).toFixed(1)}s (baselines untouched)`,
  );
} else {
  console.log(
    `[visual] generating ${MATRIX.length} fixture baselines (fixture v${VISUAL_FIXTURE_VERSION}: ` +
      `${VISUAL_FIXTURE_TITLE}; 1 fixture × 2 presets × 2 qualities; no real pipeline call)`,
  );
  const startedAt = performance.now();
  const result = generateBaselines();
  const seconds = (performance.now() - startedAt) / 1000;
  console.log(`[visual] manifest: ${MANIFEST_PATH}`);
  console.log(
    `[visual] wrote ${result.manifest.entries.length} entries, ` +
      `${(result.totalBytes / 1048576).toFixed(1)}MB of PNG in ${seconds.toFixed(1)}s ` +
      `(renderer ${result.manifest.rendererVersion}, fixtureVersion ${result.manifest.fixtureVersion}, ` +
      `fontScope ${result.manifest.fontScope})`,
  );
  console.log(
    "[visual] product cards are intentionally NOT regenerated here; use --cards-only " +
      "(they are Chinese-copy product assets and are never compared by qa:visual).",
  );
}
