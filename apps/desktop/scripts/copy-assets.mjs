#!/usr/bin/env node
/**
 * Copies everything the packaged Electron shell needs into apps/desktop/dist:
 *
 *   dist/renderer/      <- apps/web/dist (Vite renderer build), with the production
 *                          CSP injected as a <meta> tag. The packaged renderer is
 *                          served from the privileged app:// protocol
 *                          (src/main/index.ts), but the meta tag is kept as defense
 *                          in depth next to the CSP response header.
 *   dist/renderer/presets <- apps/web/public/presets (Vite copies public/ already;
 *                          this is an explicit guard so the fixtures cannot go missing)
 *   dist/assets/fonts   <- packages/render/assets/fonts (main-process offline exports
 *                          resolve `new URL("../assets/fonts/", import.meta.url)` from
 *                          dist/main/main.js, so they must live next to dist/main)
 *
 * The script is also imported by scripts/build.mjs; it only runs as a CLI when
 * executed directly.
 */
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = dirname(HERE);
const REPO_DIR = dirname(dirname(DESKTOP_DIR));

const WEB_DIST = join(REPO_DIR, "apps", "web", "dist");
const WEB_PUBLIC_PRESETS = join(REPO_DIR, "apps", "web", "public", "presets");
const RENDER_FONTS = join(REPO_DIR, "packages", "render", "assets", "fonts");

const DIST_DIR = join(DESKTOP_DIR, "dist");
const RENDERER_DIR = join(DIST_DIR, "renderer");
const FONTS_DEST = join(DIST_DIR, "assets", "fonts");

const CSP = JSON.parse(readFileSync(join(HERE, "csp.json"), "utf8"));

async function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
    else count += 1;
  }
  return count;
}

function injectCspMeta(html) {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP.prod.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" />`;
  const charset = /<meta charset="UTF-8"\s*\/?>/i;
  if (charset.test(html)) return html.replace(charset, (match) => `${match}\n    ${meta}`);
  return html.replace(/<head[^>]*>/i, (match) => `${match}\n    ${meta}`);
}

function assertRelativeRendererRefs(html) {
  const scriptRef = /<script[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? "";
  const styleRef = /<link[^>]+href="([^"]+\.css)"/i.exec(html)?.[1] ?? "";
  const absolute = [scriptRef, styleRef].filter((ref) => ref.startsWith("/"));
  if (absolute.length > 0) {
    throw new Error(
      `[copy-assets] renderer/index.html uses absolute asset URLs (${absolute.join(", ")}). ` +
        `apps/web/vite.config.ts must keep base: "./" so the file:// renderer can load its bundles.`,
    );
  }
  if (!scriptRef.startsWith("./")) {
    throw new Error(`[copy-assets] renderer/index.html script src is not relative: "${scriptRef}"`);
  }
  return { scriptRef, styleRef };
}

export async function copyRendererAssets() {
  const webIndex = join(WEB_DIST, "index.html");
  if (!existsSync(webIndex)) {
    throw new Error(`[copy-assets] missing ${webIndex}; run "pnpm -C apps/web build" first.`);
  }

  await rm(RENDERER_DIR, { recursive: true, force: true });
  await cp(WEB_DIST, RENDERER_DIR, { recursive: true });
  const rendererFiles = await countFiles(RENDERER_DIR);

  // The presets fixtures are public/ assets, so Vite normally emits them already.
  // Copy explicitly if they are missing and always verify the count to avoid a
  // silent empty welcome screen in the packaged app.
  const sourcePresets = await countFiles(WEB_PUBLIC_PRESETS);
  if (sourcePresets === 0) throw new Error(`[copy-assets] no preset fixtures under ${WEB_PUBLIC_PRESETS}`);
  const rendererPresets = join(RENDERER_DIR, "presets");
  if (!existsSync(rendererPresets)) {
    await cp(WEB_PUBLIC_PRESETS, rendererPresets, { recursive: true });
  }
  const presetFiles = await countFiles(rendererPresets);
  if (presetFiles < sourcePresets) {
    throw new Error(`[copy-assets] preset copy incomplete: ${presetFiles}/${sourcePresets} files in ${rendererPresets}`);
  }

  // Main-process exports (PNG/SVG) use the same bundled fonts as the browser.
  if (!existsSync(RENDER_FONTS)) throw new Error(`[copy-assets] missing render font assets: ${RENDER_FONTS}`);
  await rm(FONTS_DEST, { recursive: true, force: true });
  await cp(RENDER_FONTS, FONTS_DEST, { recursive: true });
  const fontFiles = await countFiles(FONTS_DEST);

  const indexPath = join(RENDERER_DIR, "index.html");
  const html = await readFile(indexPath, "utf8");
  const withCsp = injectCspMeta(html);
  if (withCsp !== html) await writeFile(indexPath, withCsp, "utf8");
  const refs = assertRelativeRendererRefs(withCsp);

  console.log(`[copy-assets] renderer: ${rendererFiles} files -> ${RENDERER_DIR}`);
  console.log(`[copy-assets] presets:  ${presetFiles}/${sourcePresets} fixtures -> ${rendererPresets}`);
  console.log(`[copy-assets] fonts:    ${fontFiles} files -> ${FONTS_DEST}`);
  console.log(`[copy-assets] entry:    ${refs.scriptRef} ${refs.styleRef ? `+ ${refs.styleRef}` : ""}`);
  console.log(`[copy-assets] CSP meta: ${CSP.prod}`);
  return { rendererFiles, presetFiles, fontFiles };
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  copyRendererAssets().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
