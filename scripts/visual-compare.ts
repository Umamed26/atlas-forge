/**
 * Compare freshly rendered maps against the committed visual baselines.
 *
 *   tsx scripts/visual-compare.ts             # fail (exit 1) on regression
 *   tsx scripts/visual-compare.ts --update    # regenerate baselines, then verify
 *   pnpm qa:visual                            # same
 *
 * A regression is any entry whose pixel difference exceeds 0.15% of the image
 * (sha-only changes within tolerance are reported but do not fail), or a
 * missing baseline image / matrix entry.
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
console.log(`[visual] OK — all ${result.entries.length} entries match within 0.15% pixel tolerance.`);
