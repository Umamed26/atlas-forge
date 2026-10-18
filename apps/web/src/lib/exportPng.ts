/**
 * PNG export: local (1024 / 2048) in a dedicated worker, and large-image export
 * through the Node backend (`POST /api/render`) for 4096 / 8192.
 */
import {
  createPipeline,
  type ProgressUpdate,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";

import { renderMapToCanvas, canvasToBlob } from "./renderMap";
import { slugify } from "./utils";

export type ExportErrorKind =
  | "network"
  | "timeout"
  | "http"
  | "format"
  | "render"
  | "worker"
  | "unsupported";

export class ExportError extends Error {
  readonly kind: ExportErrorKind;
  readonly detail: string | null;

  constructor(kind: ExportErrorKind, message: string, detail: string | null = null) {
    super(message);
    this.name = "ExportError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface ExportMeta {
  size: number;
  simSize: number | null;
  totalMs: number | null;
  simMs: number | null;
  renderMs: number | null;
  landFraction: number | null;
  settlements: number | null;
  labels: number | null;
  fontsReady: boolean | null;
}

export interface ExportResult {
  blob: Blob;
  meta: ExportMeta;
}

export type ExportProgress = (update: ProgressUpdate) => void;

export function pngFilename(document: WorldDocument, size: number): string {
  return `${slugify(document.name)}-${document.seed}-${size}.png`;
}

function localSimSize(document: WorldDocument): number {
  const grid = Math.round(document.params.gridSize);
  return Math.min(2048, Math.max(512, grid));
}

// ── Local export worker ───────────────────────────────────────────────────

interface WorkerDoneMessage {
  type: "done";
  taskId: number;
  blob: Blob;
  meta: Omit<ExportMeta, "landFraction" | "fontsReady"> & {
    landFraction: number;
    fontsReady: boolean;
  };
}

interface WorkerErrorMessage {
  type: "error";
  taskId: number;
  code: string;
  message: string;
}

interface WorkerProgressMessage {
  type: "progress";
  taskId: number;
  update: ProgressUpdate;
}

type WorkerReply = WorkerDoneMessage | WorkerErrorMessage | WorkerProgressMessage;

let exportTaskCounter = 0;

function exportWithWorker(
  document: WorldDocument,
  size: number,
  onProgress?: ExportProgress,
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    const taskId = ++exportTaskCounter;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../worker/exportWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (error) {
      reject(
        new ExportError(
          "unsupported",
          "无法创建导出 worker，将尝试主线程导出",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    let settled = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new ExportError("timeout", "本地导出超时（90 秒），请尝试更小的尺寸", null));
    }, 90_000);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (!message || message.taskId !== taskId) return;
      if (message.type === "progress") {
        onProgress?.(message.update);
        return;
      }
      if (message.type === "done") {
        cleanup();
        resolve({
          blob: message.blob,
          meta: {
            size: message.meta.size,
            simSize: message.meta.simSize,
            totalMs: message.meta.totalMs,
            simMs: message.meta.simMs,
            renderMs: message.meta.renderMs,
            landFraction: message.meta.landFraction,
            settlements: message.meta.settlements,
            labels: message.meta.labels,
            fontsReady: message.meta.fontsReady,
          },
        });
        return;
      }
      if (message.type === "error") {
        cleanup();
        reject(
          new ExportError(
            message.code === "unsupported" ? "unsupported" : "render",
            message.message,
          ),
        );
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new ExportError("worker", event.message || "导出 worker 崩溃"));
    };

    worker.postMessage({
      type: "export",
      taskId,
      document,
      size,
      simSize: localSimSize(document),
    });
  });
}

async function exportOnMainThread(
  document: WorldDocument,
  size: number,
  onProgress?: ExportProgress,
): Promise<ExportResult> {
  // Yield once so the dialog can paint its progress state before we block.
  await new Promise((resolve) => window.setTimeout(resolve, 40));
  const startedAt = performance.now();
  const pipeline = createPipeline();
  const layers: WorldLayers = pipeline.generate({
    document,
    size: localSimSize(document),
    onProgress: (update) => onProgress?.(update),
  });
  onProgress?.({
    stage: "done",
    label: "光栅化",
    progress: 0.95,
    elapsedMs: performance.now() - startedAt,
  });
  const canvas = renderMapToCanvas(layers, document, size, "export");
  const blob = await canvasToBlob(canvas);
  return {
    blob,
    meta: {
      size,
      simSize: layers.size,
      totalMs: performance.now() - startedAt,
      simMs: layers.stats.totalMs,
      renderMs: performance.now() - startedAt - layers.stats.totalMs,
      landFraction: layers.stats.landFraction,
      settlements: layers.settlements.length,
      labels: layers.autoLabels.length,
      fontsReady:
        typeof window !== "undefined" && typeof FontFace !== "undefined"
          ? window.document.fonts.check('16px "EB Garamond"')
          : false,
    },
  };
}

/**
 * Export a PNG locally. Uses a worker + OffscreenCanvas when available and
 * falls back to a (blocking) main-thread render otherwise.
 */
export async function exportLocalPng(
  document: WorldDocument,
  size: number,
  onProgress?: ExportProgress,
): Promise<ExportResult> {
  if (typeof Worker !== "undefined") {
    try {
      return await exportWithWorker(document, size, onProgress);
    } catch (error) {
      if (error instanceof ExportError && error.kind === "unsupported") {
        return exportOnMainThread(document, size, onProgress);
      }
      throw error;
    }
  }
  return exportOnMainThread(document, size, onProgress);
}

// ── Server (Node backend) export ──────────────────────────────────────────

export interface ServerExportOptions {
  timeoutMs?: number;
}

export async function exportServerPng(
  document: WorldDocument,
  size: number,
  options: ServerExportOptions = {},
): Promise<ExportResult> {
  const timeoutMs = options.timeoutMs ?? (size >= 8192 ? 180_000 : 120_000);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document, size, allowLarge: size >= 8192 }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ExportError(
        "timeout",
        `导出服务在 ${Math.round(timeoutMs / 1000)} 秒内没有返回，请降低尺寸或改用本地导出`,
        error instanceof Error ? error.message : null,
      );
    }
    throw new ExportError(
      "network",
      "无法连接导出服务：请确认 Node API 已启动（pnpm dev 会同时启动 5173 与 8787）",
      error instanceof Error ? error.message : null,
    );
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = "";
    let code = "";
    try {
      const text = await response.text();
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const record = parsed as { error?: unknown; code?: unknown };
        detail = record.error ? String(record.error) : "";
        code = record.code ? String(record.code) : "";
      } else {
        detail = text.slice(0, 300);
      }
    } catch {
      // ignore body parse errors
    }
    const hints: Record<string, string> = {
      LARGE_RENDER_DISABLED: "服务端未允许 8192²，请改用 4096² 或更小尺寸。",
      RENDERER_BUSY: "导出服务正忙，请稍等几秒后重试。",
      RENDER_TIMEOUT: "服务端渲染超时，请降低尺寸后重试。",
      INSUFFICIENT_MEMORY: "服务端内存不足，请降低尺寸后重试。",
      INVALID_DOCUMENT: "服务端拒绝了世界文档（文档字段无效），请先导出 JSON 检查数据。",
    };
    const hint = hints[code];
    throw new ExportError(
      "http",
      `${hint ?? `导出服务返回错误 HTTP ${response.status}`}${detail && !hint ? `：${detail}` : ""}`,
      detail || code || null,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new ExportError(
      "format",
      `导出服务返回了非图片响应（${contentType || "未知类型"}）`,
      contentType,
    );
  }

  const blob = await response.blob();
  const renderMsHeader = Number(response.headers.get("x-atlas-render-ms"));
  const simSizeHeader = Number(response.headers.get("x-atlas-sim-size"));
  return {
    blob,
    meta: {
      size,
      simSize: Number.isFinite(simSizeHeader) && simSizeHeader > 0 ? simSizeHeader : null,
      totalMs: performance.now() - startedAt,
      simMs: null,
      renderMs: Number.isFinite(renderMsHeader) && renderMsHeader > 0 ? renderMsHeader : null,
      landFraction: null,
      settlements: null,
      labels: null,
      fontsReady: null,
    },
  };
}
