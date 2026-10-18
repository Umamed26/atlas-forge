/// <reference lib="es2022" />
/**
 * Local PNG export worker: generate layers + rasterize at export size off the
 * main thread, then convert to a PNG blob and post it back.
 *
 * Protocol:
 *   main → worker: { type: "export", taskId, document, size, simSize }
 *   worker → main: { type: "progress", taskId, update }
 *                  { type: "done", taskId, blob, meta }
 *                  { type: "error", taskId, code, message }
 */
import { createPipeline, type ProgressUpdate, type WorldDocument } from "@atlas/core";
import { renderWorld, type Ctx2D } from "@atlas/render";

interface ExportRequest {
  type: "export";
  taskId: number;
  document: WorldDocument;
  size: number;
  simSize: number;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ExportRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let lastProgressAt = 0;

const WEB_FONT_FAMILY = "EB Garamond";
const FONT_FILES: { file: string; style: "normal" | "italic" }[] = [
  { file: "EBGaramond-Regular.ttf", style: "normal" },
  { file: "EBGaramond-Italic.ttf", style: "italic" },
];

/**
 * Register the bundled render fonts for the worker's OffscreenCanvas so local
 * 1024/2048 PNG exports use the same typography as the preview and the Node
 * 4096² export. Silently falls back to the serif stack on failure.
 */
async function ensureWorkerFonts(): Promise<boolean> {
  const scope = self as unknown as {
    fonts?: FontFaceSet;
    location: { origin: string };
  };
  if (!scope.fonts || typeof FontFace === "undefined") return false;
  let loadedAny = false;
  for (const { file, style } of FONT_FILES) {
    try {
      const url = new URL(`/fonts/${file}`, scope.location.origin).href;
      const face = new FontFace(WEB_FONT_FAMILY, `url("${url}")`, { style });
      await face.load();
      scope.fonts.add(face);
      loadedAny = true;
    } catch {
      // Fallback stack remains usable.
    }
  }
  if (loadedAny) {
    // `FontFaceSet.ready` may never settle inside a dedicated worker (no layout),
    // so never let typography readiness block a local export.
    try {
      await Promise.race([
        scope.fonts.ready,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      // ignore
    }
  }
  return loadedAny;
}

function postProgress(taskId: number, update: ProgressUpdate): void {
  const now = Date.now();
  if (update.stage !== "done" && now - lastProgressAt < 50) return;
  lastProgressAt = now;
  workerScope.postMessage({ type: "progress", taskId, update });
}

async function handleExport(request: ExportRequest): Promise<void> {
  const { taskId, document, size, simSize } = request;
  try {
    if (typeof OffscreenCanvas === "undefined") {
      workerScope.postMessage({
        type: "error",
        taskId,
        code: "unsupported",
        message: "当前环境不支持 OffscreenCanvas",
      });
      return;
    }
    const fontsReady = await ensureWorkerFonts();
    const generatedAt = performance.now();
    const pipeline = createPipeline();
    const layers = pipeline.generate({
      document,
      size: simSize,
      onProgress: (update) => postProgress(taskId, update),
    });
    const simMs = performance.now() - generatedAt;

    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建离屏渲染上下文（OffscreenCanvas 2D）");
    const renderStartedAt = performance.now();
    renderWorld({
      ctx: ctx as unknown as Ctx2D,
      width: size,
      height: size,
      document,
      layers,
      quality: "export",
    });
    const renderMs = performance.now() - renderStartedAt;
    const blob = await canvas.convertToBlob({ type: "image/png" });
    workerScope.postMessage({
      type: "done",
      taskId,
      blob,
      meta: {
        size,
        simSize,
        simMs,
        renderMs,
        totalMs: performance.now() - generatedAt,
        fontsReady,
        landFraction: layers.stats.landFraction,
        settlements: layers.settlements.length,
        labels: layers.autoLabels.length,
      },
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      taskId,
      code: "render",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

workerScope.onmessage = (event: MessageEvent<ExportRequest>) => {
  const message = event.data;
  if (!message || message.type !== "export") return;
  void handleExport(message);
};
