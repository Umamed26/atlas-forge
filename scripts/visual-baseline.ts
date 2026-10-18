/**
 * Generate the visual regression baseline set (512² latin-only PNGs + 256²
 * thumbnails) and, in the same run, the product preset cards for the welcome
 * screen (256², Chinese titles).
 *
 *   tsx scripts/visual-baseline.ts              # baselines + cards
 *   tsx scripts/visual-baseline.ts --cards-only # only refresh product cards
 *   pnpm qa:baseline                            # same as first form
 *
 * Outputs:
 *   packages/render/test/baselines/<entry>.png         512² reference plate
 *   packages/render/test/baselines/thumbs/<entry>.png  256² thumbnail
 *   packages/render/test/baselines/manifest.json       sha256/metrics/fontScope
 *   apps/web/public/presets/<scenario>.png             product cards (Chinese, not compared)
 *
 * Visual baselines are font-independent on purpose: every baseline document uses
 * `namingLanguage: "latin"` and an ASCII cartouche title, so only the bundled
 * EB Garamond font is required and local Skia vs CI runners render the same
 * glyphs. The welcome-screen cards keep the Chinese product copy and are
 * generated through a separate path because they are product assets, not part
 * of the CI comparison.
 */
import {
  generateBaselines,
  generatePresetCards,
  MANIFEST_PATH,
  PRESET_THUMB_DIR,
  SCENARIOS,
  MATRIX,
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
    `[visual] generating ${MATRIX.length} latin-only baselines from ${SCENARIOS.length} core SCENARIO_PRESETS ` +
      `(512² plates; judge: Δ>16 pixels ≤0.15% + 64² mean Δ≤3.0, sha256 informational)`,
  );
  const startedAt = performance.now();
  const result = generateBaselines();
  const seconds = (performance.now() - startedAt) / 1000;
  console.log(`[visual] manifest: ${MANIFEST_PATH}`);
  console.log(`[visual] product cards (Chinese): ${PRESET_THUMB_DIR}/<scenario>.png`);
  console.log(
    `[visual] wrote ${result.manifest.entries.length} entries, ` +
      `${(result.totalBytes / 1048576).toFixed(1)}MB of PNG in ${seconds.toFixed(1)}s ` +
      `(renderer ${result.manifest.rendererVersion}, fontScope ${result.manifest.fontScope})`,
  );
}
