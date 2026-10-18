/**
 * Font configuration shared by the browser and Node renderers.
 *
 * The renderer never assumes a specific font is present: callers may register
 * the bundled EB Garamond (OFL) on either platform and then call
 * `configureRenderFonts`. If the font is missing the fallback stack still
 * resolves to a serif face, so a missing font can never crash rendering.
 *
 * - Node: `@atlas/render/node-fonts` (imported by the server / QA scripts)
 *   registers the bundled TTFs with `GlobalFonts` under one family name.
 * - Browser: `installBrowserFonts()` loads the same TTFs via the FontFace API
 *   (ui layer may call it once at startup; it is a no-op in Node).
 */

export interface RenderFontConfig {
  /** CSS font list for upright serif text. */
  latin: string;
  /** CSS font list for italic serif text (water / sub titles). */
  latinItalic: string;
  /** CSS font list for CJK text (comma separated families). */
  cjk: string;
  /** The family name reported in diagnostics, e.g. "EB Garamond". */
  resolvedFamily: string;
}

export const BUNDLED_FONT_FAMILY = "EB Garamond";

/**
 * Structural access to browser-only globals without pulling DOM type names
 * into this file (the Node server type-checks this source without lib.dom).
 */
interface BrowserFontFace {
  load(): Promise<unknown>;
}
interface BrowserGlobals {
  window?: unknown;
  document?: { fonts?: { add(face: unknown): void } };
  FontFace?: new (
    family: string,
    source: string,
    descriptors?: { style?: string },
  ) => BrowserFontFace;
  URL?: new (input: string, base?: string) => { href: string };
}

const GLOBALS = globalThis as unknown as BrowserGlobals;
const IS_BROWSER = typeof GLOBALS.window !== "undefined" && typeof GLOBALS.document !== "undefined";

const BROWSER_CJK_STACK =
  '"Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", "IPAMincho", serif';
const NODE_CJK_STACK = '"IPAMincho", "IPAPMincho", "Noto Serif CJK SC", "WenQuanYi Zen Hei", serif';

function createDefaultConfig(): RenderFontConfig {
  return {
    latin: '"EB Garamond", "Liberation Serif", "DejaVu Serif", "FreeSerif", serif',
    latinItalic: '"EB Garamond", "Liberation Serif", "DejaVu Serif", "FreeSerif", serif',
    cjk: IS_BROWSER ? BROWSER_CJK_STACK : NODE_CJK_STACK,
    resolvedFamily: BUNDLED_FONT_FAMILY,
  };
}

let currentFonts: RenderFontConfig = createDefaultConfig();

/** Override the font configuration (called after fonts are registered). */
export function configureRenderFonts(partial: Partial<RenderFontConfig>): RenderFontConfig {
  currentFonts = { ...currentFonts, ...partial };
  return currentFonts;
}

export function getRenderFonts(): RenderFontConfig {
  return currentFonts;
}

/** Build a CSS font shorthand for serif text. */
export function serifFont(sizePx: number, italic = false): string {
  const family = italic ? currentFonts.latinItalic : currentFonts.latin;
  return `${italic ? "italic " : ""}${Math.max(1, sizePx).toFixed(2)}px ${family}`;
}

/** Build a CSS font shorthand for CJK-capable serif text. */
export function cjkFont(sizePx: number, italic = false): string {
  // CJK glyphs are upright in traditional cartography; italic is reserved for
  // Latin water names. Keep the italic request but no synthetic slant family.
  return `${italic ? "italic " : ""}${Math.max(1, sizePx).toFixed(2)}px ${currentFonts.cjk}`;
}

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** True when text contains CJK characters and should use the CJK stack. */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** Font shorthand appropriate for a text run (CJK aware). */
export function textFont(text: string, sizePx: number, italic = false): string {
  return hasCjk(text) ? cjkFont(sizePx, italic) : serifFont(sizePx, italic);
}

/**
 * Load the bundled OFL fonts in the browser. Safe no-op in Node.
 * Returns true when the FontFace API accepted at least the regular face.
 */
export async function installBrowserFonts(): Promise<boolean> {
  if (!IS_BROWSER) return false;
  const fontSet = GLOBALS.document?.fonts;
  const Face = GLOBALS.FontFace;
  const URLCtor = GLOBALS.URL;
  if (!fontSet || typeof Face !== "function" || typeof URLCtor !== "function") return false;
  const faces: Array<{ file: string; style: "normal" | "italic" }> = [
    { file: "EBGaramond-Regular.ttf", style: "normal" },
    { file: "EBGaramond-Italic.ttf", style: "italic" },
  ];
  let loaded = false;
  for (const face of faces) {
    try {
      const url = new URLCtor(`../assets/fonts/${face.file}`, import.meta.url).href;
      const fontFace = new Face(BUNDLED_FONT_FAMILY, `url(${url})`, { style: face.style });
      await fontFace.load();
      fontSet.add(fontFace);
      loaded = true;
    } catch {
      // Font file unavailable at runtime: fallback stack remains in place.
    }
  }
  if (loaded) configureRenderFonts({ resolvedFamily: BUNDLED_FONT_FAMILY });
  return loaded;
}
