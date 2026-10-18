/**
 * Node-side font installation for the export server / QA scripts.
 *
 * Kept in a separate entry point (`@atlas/render/node-fonts`) so the browser
 * bundle never pulls in `node:fs`. Every registration is guarded: a missing
 * asset or a rejected font file must never crash rendering — the renderer's
 * fallback stack simply resolves to a system serif.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_FONT_FAMILY, configureRenderFonts, type RenderFontConfig } from "./fonts";

export interface GlobalFontsLike {
  has(family: string): boolean;
  registerFromPath(path: string, family?: string): unknown;
}

export interface NodeFontInstallResult {
  source: "bundled" | "system" | "none";
  family: string;
  /** Family name used in font stacks; always safe to pass to fillText. */
  configuredFamily: string;
  loadedFiles: string[];
  errors: string[];
  assetDir: string;
}

const FALLBACK_SERIF_PATHS = [
  "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/usr/share/fonts/TTF/LiberationSerif-Regular.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  "C:\\Windows\\Fonts\\times.ttf",
];

function defaultAssetDir(): string {
  try {
    return fileURLToPath(new URL("../assets/fonts/", import.meta.url));
  } catch {
    return "";
  }
}

/**
 * Register the bundled EB Garamond (OFL) TTFs under one family. Falls back to
 * registering a system serif, then to the renderer's built-in fallback stack.
 */
export function installNodeFonts(
  globalFonts: GlobalFontsLike,
  options: { assetDir?: string; quiet?: boolean } = {},
): NodeFontInstallResult {
  const assetDir = options.assetDir ?? defaultAssetDir();
  const loadedFiles: string[] = [];
  const errors: string[] = [];
  const bundled = [
    { file: "EBGaramond-Regular.ttf", family: BUNDLED_FONT_FAMILY },
    { file: "EBGaramond-Italic.ttf", family: BUNDLED_FONT_FAMILY },
  ];
  for (const entry of bundled) {
    const path = join(assetDir, entry.file);
    if (!existsSync(path)) {
      errors.push(`missing font asset: ${path}`);
      continue;
    }
    try {
      globalFonts.registerFromPath(path, entry.family);
      loadedFiles.push(path);
    } catch (error) {
      errors.push(`registered failed for ${entry.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const bundledOk = globalFonts.has(BUNDLED_FONT_FAMILY);
  let family = bundledOk ? BUNDLED_FONT_FAMILY : "Liberation Serif";
  let source: NodeFontInstallResult["source"] = bundledOk ? "bundled" : "none";
  if (!bundledOk) {
    for (const path of FALLBACK_SERIF_PATHS) {
      if (!existsSync(path)) continue;
      try {
        globalFonts.registerFromPath(path);
        source = "system";
        if (!globalFonts.has(family)) family = "Liberation Serif";
        break;
      } catch (error) {
        errors.push(`fallback font failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const config: RenderFontConfig = configureRenderFonts({
    latin: `"${family}", "Liberation Serif", "DejaVu Serif", "FreeSerif", serif`,
    latinItalic: `"${family}", "Liberation Serif", "DejaVu Serif", "FreeSerif", serif`,
    resolvedFamily: family,
  });
  if (!options.quiet) {
    console.log(
      `[atlas/render] fonts: source=${source} family=${family} files=${loadedFiles.length}` +
        (errors.length > 0 ? ` errors=${JSON.stringify(errors)}` : ""),
    );
  }
  return {
    source,
    family: config.resolvedFamily,
    configuredFamily: config.resolvedFamily,
    loadedFiles,
    errors,
    assetDir,
  };
}
