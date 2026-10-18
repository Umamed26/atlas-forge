/**
 * Generate the visual regression baseline set (1024² PNGs + 256² thumbnails).
 *
 *   tsx scripts/visual-baseline.ts            # write / refresh baselines
 *   pnpm qa:baseline                          # same (root script added by Lead)
 *
 * Outputs:
 *   packages/render/test/baselines/<entry>.png         1024² reference plate
 *   packages/render/test/baselines/thumbs/<entry>.png  256² thumbnail
 *   packages/render/test/baselines/manifest.json       sha256 + metrics + renderer version
 *   apps/web/public/presets/<scenario>.png             first-screen scenario cards
 */
import { generateBaselines, MANIFEST_PATH, PRESET_THUMB_DIR, SCENARIOS, MATRIX } from "./visual-lib";

const args = new Set(process.argv.slice(2));
void args; // --update is accepted for symmetry; this script always writes.

console.log(
  `[visual] generating ${MATRIX.length} baselines from ${SCENARIOS.length} core SCENARIO_PRESETS ` +
    `(512² plates; judge: Δ>16 pixels ≤0.15% + 64² mean Δ≤3.0, sha256 informational)`,
);
const startedAt = performance.now();
const result = generateBaselines();
const seconds = (performance.now() - startedAt) / 1000;
console.log(`[visual] manifest: ${MANIFEST_PATH}`);
console.log(`[visual] preset cards: ${PRESET_THUMB_DIR}/<scenario>.png`);
console.log(
  `[visual] wrote ${result.manifest.entries.length} entries, ` +
    `${(result.totalBytes / 1048576).toFixed(1)}MB of PNG in ${seconds.toFixed(1)}s ` +
    `(renderer ${result.manifest.rendererVersion})`,
);
console.log(
  "[visual] preset cards are rendered at 1024² and downscaled to 256² for the welcome screen; " +
    "re-run this script whenever core SCENARIO_PRESETS changes.",
);
