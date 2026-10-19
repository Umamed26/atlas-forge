#!/usr/bin/env node
/**
 * Bundles the Electron entry points with esbuild.
 *
 * Why bundle instead of plain `tsc`?
 *  - packages/core and packages/render export TypeScript sources (`exports` maps
 *    to `./src/index.ts`), so Electron's runtime cannot import them directly.
 *  - A `sandbox: true` preload script must be a single CommonJS file: the sandboxed
 *    `require` polyfill only provides electron/events/timers/url, it cannot load
 *    sibling modules.
 *
 * Output layout (consumed by src/main/index.ts and electron-builder.yml):
 *   dist/main/main.js       ESM main process  (electron + @napi-rs/canvas external)
 *   dist/preload/index.cjs  CJS preload       (electron external)
 *
 * Renderer/static copies are handled by scripts/copy-assets.mjs.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { copyRendererAssets } from "./copy-assets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(HERE);
const DIST_DIR = join(APP_DIR, "dist");
const noAssets = process.argv.includes("--no-assets");

/** Shared esbuild options: Node target, native modules never bundled. */
const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  absWorkingDir: APP_DIR,
  external: ["electron", "@napi-rs/canvas"],
};

async function main() {
  rmSync(join(DIST_DIR, "main"), { recursive: true, force: true });
  rmSync(join(DIST_DIR, "preload"), { recursive: true, force: true });

  console.log("[build] main    -> dist/main/main.js (esm)");
  await build({
    ...shared,
    entryPoints: [join(APP_DIR, "src", "main", "index.ts")],
    outfile: join(DIST_DIR, "main", "main.js"),
    format: "esm",
  });

  console.log("[build] preload -> dist/preload/index.cjs (cjs, single file for sandbox)");
  await build({
    ...shared,
    entryPoints: [join(APP_DIR, "src", "preload", "index.ts")],
    outfile: join(DIST_DIR, "preload", "index.cjs"),
    format: "cjs",
  });

  if (!noAssets) await copyRendererAssets();
  console.log("[build] done");
}

main().catch((error) => {
  console.error("[build] failed:", error);
  process.exit(1);
});
