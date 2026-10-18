/**
 * Compare freshly rendered fixture plates against the committed visual baselines.
 *
 *   tsx scripts/visual-compare.ts             # fail (exit 1) on regression
 *   tsx scripts/visual-compare.ts --update    # regenerate baselines, then verify
 *   pnpm qa:visual                            # same
 *
 * The plates come from the fixed synthetic fixture (NOT the real pipeline), so
 * this gate only fails when the renderer/theme changes — core algorithm work
 * does not invalidate it. The manifest records `fixtureVersion` and
 * `fontScope: latin-only`.
 *
 * Pass/fail uses the tolerant judge (scripts/visual-lib.ts):
 *   - per-pixel: only channel deltas > 16 count, structural diff must be <= 0.15%;
 *   - structural: 64×64 downsampled max channel mean delta must be <= 3.0.
 * sha256 is printed as a diagnostic reference only, so CI font/AA differences
 * between environments do not fail the gate; real look changes still do.
 * A missing baseline image or matrix entry also fails.
 */
import { generateBaselines, loadManifest, runVisualCompare } from "./visual-lib";

const update = process.argv.includes("--update");

if (update) {
  console.log("[visual] --update: regenerating baselines first");
  generateBaselines();
}

const manifest = loadManifest();
if (!manifest) {
  console.error(
    "[visual] no baseline manifest found. Run `tsx scripts/visual-baseline.ts` (or `pnpm qa:visual -- --update`) to create one.",
  );
  process.exit(1);
}

console.log(
  `[visual] comparing ${manifest.entries.length} entries against ` +
    `packages/render/test/baselines/manifest.json (baseline renderer ${manifest.rendererVersion})`,
);

const result = await runVisualCompare({ missingBaseline: "fail" });
if (!result.ok) {
  console.error(
    `[visual] regression detected (${result.entries.filter((entry) => entry.status !== "ok").length} entries). ` +
      "If the visual change is intentional, refresh the baseline with `pnpm qa:visual -- --update`.",
  );
  process.exit(1);
}
console.log(`[visual] OK — all ${result.entries.length} entries pass the tolerant structural judge (Δ>16 pixels ≤0.15%, 64² mean Δ≤3.0).`);
