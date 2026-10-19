/**
 * Offline exports: render PNG / SVG in the main process with the exact same
 * pipeline + renderer as the browser (packages/core + packages/render), no HTTP
 * server required. This is what makes 4096/8192 usable with the network off.
 *
 * Robustness rules (v0.7):
 *   - fonts are installed *before* the first render (awaited, not fire&forget)
 *   - the renderer document is re-validated with core's normalizer so a stale
 *     renderer can never crash the main process
 *   - 8192² needs ~270 MB for the RGBA canvas: allocation/render/write errors
 *     are converted into readable messages the renderer shows in a toast
 *   - exports are serialized (one render+write at a time) to cap peak memory
 *   - the offscreen canvas bitmap is released as soon as the buffer exists
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

import { createPipeline, normalizeWorldDocument, type WorldDocument } from "@atlas/core";
import {
  renderSvg,
  renderWorld,
  type Ctx2D,
  type SvgPage,
  type SvgPhysicalSize,
} from "@atlas/render";

import {
  IPC,
  type DesktopExportRequest,
  type DesktopExportResult,
} from "../../shared/ipc";

interface ExportDeps {
  getWindow: () => BrowserWindow | null;
}

// ── Font readiness (awaited: first export must not race registration) ─────

let fontsPromise: Promise<void> | null = null;

function ensureFonts(): Promise<void> {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      try {
        // Bundled EB Garamond ships with @atlas/render; register it under a stable
        // family name so desktop exports match the browser byte-for-byte.
        const mod = await import("@atlas/render/node-fonts");
        mod.installNodeFonts(GlobalFonts, { quiet: true });
      } catch (error) {
        // A missing font asset must never fail an export; the renderer falls back
        // to the system serif stack.
        console.warn("[exports] node font install failed, using serif fallback", error);
      }
    })();
  }
  return fontsPromise;
}

// ── Request validation ────────────────────────────────────────────────────

const MAX_SIZE = 8192;
const MIN_SIZE = 512;

function clampSize(requested: number): number {
  if (!Number.isFinite(requested)) return 2048;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(requested)));
}

function validationMessage(
  issues: { path: string; message: string }[],
): string {
  return issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("；");
}

/** Core-normalize the renderer document before touching the renderer. */
function validatedDocument(input: WorldDocument): WorldDocument {
  let normalized: ReturnType<typeof normalizeWorldDocument>;
  try {
    normalized = normalizeWorldDocument(input);
  } catch (error) {
    throw new Error(
      `世界文档无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const errors = normalized.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(`世界文档无效：${validationMessage(errors)}`);
  }
  return normalized.document;
}

function safeNameFor(document: WorldDocument): string {
  return (document.name || "world").replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, "-");
}

// ── Serialize exports: 8192² + a second concurrent export would double the
//    peak memory and can OOM the main process. ─────────────────────────────

let exportQueue: Promise<unknown> = Promise.resolve();

function withExportLock<T>(task: () => Promise<T>): Promise<T> {
  const run = exportQueue.then(task, task);
  // Keep the chain alive even when a task rejects.
  exportQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Save target: test hook + native dialog ────────────────────────────────

/**
 * Automation hook: qa-desktop sets ATLAS_TEST_EXPORT_DIR so exports write
 * straight into that directory without showing a blocking save dialog. The
 * env var is never set in production / packaged user runs.
 */
function testExportPath(
  document: WorldDocument,
  extension: "png" | "svg",
  size: number,
): string | null {
  const dir = process.env.ATLAS_TEST_EXPORT_DIR;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return join(dir, `atlas-${safeNameFor(document)}-${document.seed}-${size}.${extension}`);
}

function defaultExportName(
  document: WorldDocument,
  extension: "png" | "svg",
  size: number,
): string {
  return `atlas-${safeNameFor(document)}-${document.seed}-${size}.${extension}`;
}

async function targetPath(
  deps: ExportDeps,
  document: WorldDocument,
  extension: "png" | "svg",
  size: number,
): Promise<string | null> {
  const automated = testExportPath(document, extension, size);
  if (automated) return automated;
  const window = deps.getWindow();
  const options = {
    title: extension === "png" ? "导出 PNG" : "导出 SVG",
    defaultPath: join(
      app.getPath("documents"),
      defaultExportName(document, extension, size),
    ),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  };
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

// ── SVG print dimensions ──────────────────────────────────────────────────

const SVG_PAGES = new Set<SvgPage>(["A4", "A3", "A2", "LETTER"]);

function svgPhysicalFor(
  request: DesktopExportRequest,
  size: number,
): SvgPhysicalSize {
  const requested = request.physical;
  const dpi =
    requested && Number.isFinite(requested.dpi) && (requested.dpi ?? 0) > 0
      ? Math.round(requested.dpi as number)
      : 300;
  const widthMm =
    requested && Number.isFinite(requested.widthMm) && (requested.widthMm ?? 0) > 0
      ? requested.widthMm
      : undefined;
  const heightMm =
    requested && Number.isFinite(requested.heightMm) && (requested.heightMm ?? 0) > 0
      ? requested.heightMm
      : undefined;
  if (widthMm && heightMm) return { dpi, widthMm, heightMm };
  const page =
    requested?.page && SVG_PAGES.has(requested.page as SvgPage)
      ? (requested.page as SvgPage)
      : undefined;
  if (page) return { dpi, page };
  // Default: square print size at the requested DPI (matches the web hints).
  const mm = Math.round(((size / dpi) * 25.4 + Number.EPSILON) * 10) / 10;
  return { dpi, widthMm: mm, heightMm: mm };
}

// ── Render helpers with readable errors ──────────────────────────────────

function allocateCanvas(size: number) {
  const approxMb = Math.round((size * size * 4) / 1024 / 1024);
  try {
    return createCanvas(size, size);
  } catch (error) {
    throw new Error(
      `无法分配 ${size}×${size} 离屏画布（约 ${approxMb} MB）：${
        error instanceof Error ? error.message : String(error)
      }。请降低导出尺寸或关闭占用内存的应用后重试。`,
    );
  }
}

function releaseCanvas(canvas: { width: number; height: number }): void {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Not fatal: GC still reclaims the bitmap.
  }
}

function writeOutput(path: string, data: Buffer | string): number {
  try {
    writeFileSync(path, data);
    return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
  } catch (error) {
    throw new Error(
      `无法写入 ${path}：${error instanceof Error ? error.message : String(error)}（请检查目录权限与磁盘空间）`,
    );
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────

export function registerExportHandlers(deps: ExportDeps): void {
  ipcMain.handle(
    IPC.exportPng,
    async (_event, request: DesktopExportRequest): Promise<DesktopExportResult> => {
      const started = performance.now();
      const size = clampSize(request.size);
      const document = validatedDocument(request.document);
      const path = await targetPath(deps, document, "png", size);
      if (!path) return { canceled: true };
      await ensureFonts();

      const result = await withExportLock(async () => {
        const pipeline = createPipeline();
        const layers = pipeline.generate({ document, size: simSizeFor(size) });
        const canvas = allocateCanvas(size);
        try {
          const ctx = canvas.getContext("2d");
          renderWorld({
            ctx: ctx as unknown as Ctx2D,
            width: size,
            height: size,
            document,
            layers,
            quality: size >= 2048 ? "export" : "preview",
          });
          const buffer = canvas.toBuffer("image/png");
          const bytes = writeOutput(path, buffer);
          return { bytes };
        } catch (error) {
          if (error instanceof Error && /^无法写入/.test(error.message)) throw error;
          throw new Error(
            `桌面 PNG 渲染失败（${size}×${size}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          releaseCanvas(canvas);
        }
      });

      return {
        canceled: false,
        path,
        bytes: result.bytes,
        ms: Math.round(performance.now() - started),
      };
    },
  );

  ipcMain.handle(
    IPC.exportSvg,
    async (_event, request: DesktopExportRequest): Promise<DesktopExportResult> => {
      const started = performance.now();
      const size = clampSize(request.size);
      const document = validatedDocument(request.document);
      const physical = svgPhysicalFor(request, size);
      const path = await targetPath(deps, document, "svg", size);
      if (!path) return { canceled: true };
      await ensureFonts();

      const result = await withExportLock(async () => {
        const pipeline = createPipeline();
        const layers = pipeline.generate({ document, size: simSizeFor(size) });
        let svg: string;
        try {
          svg = renderSvg({
            document,
            layers,
            width: size,
            height: size,
            quality: size >= 2048 ? "export" : "preview",
            physical,
          });
        } catch (error) {
          throw new Error(
            `桌面 SVG 渲染失败（${size}×${size}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        // renderSvg() may prefix the XML prolog; the web SVG export strips it so
        // the downloaded file starts with <svg (matches qa-desktop assertions).
        const normalizedSvg = svg.trimStart().replace(/^<\?xml[^>]*\?>\s*/i, "");
        if (!normalizedSvg.startsWith("<svg")) {
          throw new Error("桌面 SVG 渲染失败：渲染器没有返回有效的 SVG 文本");
        }
        const bytes = writeOutput(path, normalizedSvg);
        return { bytes };
      });

      return {
        canceled: false,
        path,
        bytes: result.bytes,
        ms: Math.round(performance.now() - started),
      };
    },
  );
}

/** Simulation resolution for a given output size (same rule as the web app). */
function simSizeFor(size: number): number {
  return Math.min(2048, Math.max(512, Math.round(size / 2)));
}
