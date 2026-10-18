/**
 * Browser font loading for the parchment renderer.
 *
 * The renderer's CSS stack already prefers "EB Garamond"; this module registers
 * the bundled OFL TTFs (served from /public/fonts) with the document so the
 * interactive preview uses the same faces as the Node 4096² export.
 *
 * Any failure is silent: the renderer falls back to the serif stack.
 */
export const RENDER_FONT_FAMILY = "EB Garamond";

const FONT_FILES: { file: string; style: "normal" | "italic" }[] = [
  { file: "EBGaramond-Regular.ttf", style: "normal" },
  { file: "EBGaramond-Italic.ttf", style: "italic" },
];

let loadPromise: Promise<boolean> | null = null;

async function loadFonts(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const fontSet = document.fonts;
  if (!fontSet || typeof FontFace === "undefined") return false;

  let loadedAny = false;
  await Promise.all(
    FONT_FILES.map(async ({ file, style }) => {
      try {
        const url = new URL(`/fonts/${file}`, window.location.origin).href;
        const face = new FontFace(RENDER_FONT_FAMILY, `url("${url}")`, { style });
        await face.load();
        fontSet.add(face);
        loadedAny = true;
      } catch {
        // Missing / blocked font file: keep the built-in serif fallback.
      }
    }),
  );

  if (loadedAny) {
    try {
      await Promise.race([
        fontSet.ready,
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
    } catch {
      // ignore
    }
  }
  return loadedAny;
}

/** Load the bundled render fonts once; safe to call from multiple places. */
export function loadRenderFonts(): Promise<boolean> {
  if (!loadPromise) loadPromise = loadFonts();
  return loadPromise;
}
