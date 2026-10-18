/**
 * SVG vector export (v0.5).
 *
 * Preferred path: client-side `renderSvg(...)` exported by @atlas/render (may
 * run in a worker in the future). Fallback: `POST /api/export/svg` on the Node
 * backend. Both paths produce `image/svg+xml`; cancel uses AbortController.
 */
import type { WorldDocument, WorldLayers } from "@atlas/core";

import { ExportError } from "./exportPng";
import { slugify } from "./utils";

export interface SvgExportMeta {
  size: number;
  totalMs: number;
  renderMs: number | null;
  simMs: number | null;
  mode: "client" | "server" | "worker";
  bytes: number;
  fontsReady: boolean | null;
}

export interface SvgExportResult {
  blob: Blob;
  filename: string;
  meta: SvgExportMeta;
}

type RenderSvgFn = (input: Record<string, unknown>) => unknown;

interface RenderModuleShape {
  renderSvg?: RenderSvgFn;
  renderSvgDocument?: RenderSvgFn;
}

let cachedClientRenderer: RenderSvgFn | null | undefined;

/** Detect the client renderer lazily so the app still works before render ships it. */
export async function getClientSvgRenderer(): Promise<RenderSvgFn | null> {
  if (cachedClientRenderer !== undefined) return cachedClientRenderer;
  try {
    const module = (await import("@atlas/render")) as unknown as RenderModuleShape;
    cachedClientRenderer =
      typeof module.renderSvg === "function"
        ? module.renderSvg
        : typeof module.renderSvgDocument === "function"
          ? module.renderSvgDocument
          : null;
  } catch {
    cachedClientRenderer = null;
  }
  return cachedClientRenderer;
}

export function svgFilename(document: WorldDocument, size: number): string {
  const world = slugify(document.name) || "world";
  const preset = document.style.preset === "aged-ink" ? "aged-ink" : "parchment";
  return `atlas-${world}-${document.seed}-${preset}-${size}.svg`;
}

function normalizeSvgOutput(output: unknown): string | null {
  const raw =
    typeof output === "string"
      ? output
      : output && typeof output === "object"
        ? (() => {
            const record = output as { svg?: unknown; data?: unknown };
            if (typeof record.svg === "string") return record.svg;
            if (typeof record.data === "string") return record.data;
            return null;
          })()
        : null;
  if (!raw) return null;
  // Drop the optional XML prolog so the downloaded file starts with <svg
  // (verified by E2E and easier for consumers to sniff).
  return raw.replace(/^\s*<\?xml[^>]*\?>\s*/i, "").trimStart();
}

export interface SvgExportOptions {
  signal?: AbortSignal;
  /** Current derived layers (optional; renderSvg may accept them to avoid a re-sim). */
  layers?: WorldLayers | null;
  onProgress?: (update: { stage: string; progress: number }) => void;
}

async function exportSvgClient(
  renderer: RenderSvgFn,
  document: WorldDocument,
  size: number,
  options: SvgExportOptions,
): Promise<{ svg: string; elapsedMs: number; mode: SvgExportMeta["mode"] }> {
  const startedAt = performance.now();
  options.onProgress?.({ stage: "生成矢量图层", progress: 0.2 });
  const invoke = (workerStyle: boolean): string | null => {
    const payload: Record<string, unknown> = {
      document,
      width: size,
      height: size,
      size,
      quality: "export",
      title: document.name,
      physical: { dpi: 300, page: size >= 8192 ? "A2" : size >= 4096 ? "A3" : size >= 2048 ? "A4" : "A5" },
    };
    if (options.layers) payload.layers = options.layers;
    if (workerStyle) {
      payload.kind = "svg";
      payload.purpose = "export";
    }
    return normalizeSvgOutput(renderer(payload));
  };
  let svg: string | null = null;
  try {
    svg = invoke(false);
  } catch {
    svg = null;
  }
  if (!svg) svg = invoke(true);
  if (!svg) throw new ExportError("render", "SVG 渲染器没有返回有效内容");
  if (options.signal?.aborted) throw new ExportError("cancelled", "已取消导出");
  options.onProgress?.({ stage: "下载 SVG", progress: 0.9 });
  return { svg, elapsedMs: performance.now() - startedAt, mode: "client" };
}

const SERVER_STAGES = ["上传世界数据", "服务端生成", "服务端渲染 SVG", "下载 SVG"];

async function exportSvgServer(
  document: WorldDocument,
  size: number,
  options: SvgExportOptions,
): Promise<{ svg: string; blob: Blob; serverMs: number }> {
  const startedAt = performance.now();
  const url = "/api/export/svg";
  options.onProgress?.({ stage: SERVER_STAGES[0], progress: 0.08 });
  let stageIndex = 0;
  const stageTimer = window.setInterval(() => {
    stageIndex = Math.min(SERVER_STAGES.length - 1, stageIndex + 1);
    options.onProgress?.({
      stage: SERVER_STAGES[stageIndex],
      progress: Math.min(0.85, 0.08 + stageIndex * 0.22),
    });
  }, 1200);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document, size }),
      signal: options.signal,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new ExportError("http", `SVG 导出服务失败：${detail}`);
    }
    const blob = await response.blob();
    const text = await blob.text();
    if (!text.trimStart().startsWith("<svg")) {
      throw new ExportError("render", "导出服务返回的内容不是 SVG");
    }
    return { svg: text, blob: new Blob([text], { type: "image/svg+xml" }), serverMs: performance.now() - startedAt };
  } finally {
    window.clearInterval(stageTimer);
  }
}

/** Export an SVG, preferring the client renderer and falling back to the API. */
export async function exportSvg(
  document: WorldDocument,
  size: number,
  options: SvgExportOptions = {},
): Promise<SvgExportResult> {
  const startedAt = performance.now();
  const filename = svgFilename(document, size);
  const renderer = await getClientSvgRenderer();
  try {
    if (renderer) {
      const local = await exportSvgClient(renderer, document, size, options);
      const blob = new Blob([local.svg], { type: "image/svg+xml" });
      if (options.signal?.aborted) throw new ExportError("cancelled", "已取消导出");
      options.onProgress?.({ stage: "完成", progress: 1 });
      return {
        blob,
        filename,
        meta: {
          size,
          totalMs: performance.now() - startedAt,
          renderMs: local.elapsedMs,
          simMs: null,
          mode: local.mode,
          bytes: blob.size,
          fontsReady: null,
        },
      };
    }
    const server = await exportSvgServer(document, size, options);
    if (options.signal?.aborted) throw new ExportError("cancelled", "已取消导出");
    options.onProgress?.({ stage: "完成", progress: 1 });
    return {
      blob: server.blob,
      filename,
      meta: {
        size,
        totalMs: performance.now() - startedAt,
        renderMs: server.serverMs,
        simMs: null,
        mode: "server",
        bytes: server.blob.size,
        fontsReady: null,
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw new ExportError("cancelled", "已取消导出");
    throw error;
  }
}

export async function hasSvgExport(): Promise<boolean> {
  if ((await getClientSvgRenderer()) !== null) return true;
  try {
    // Probe the actual endpoint: validation errors (400/422) mean the route
    // exists; 404/405 means this deployment has no SVG renderer yet.
    const response = await fetch("/api/export/svg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ probe: true }),
      signal: AbortSignal.timeout(2500),
    });
    return response.status !== 404 && response.status !== 405;
  } catch {
    return false;
  }
}
