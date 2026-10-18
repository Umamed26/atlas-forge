/**
 * Atlas Forge export server.
 *
 * Renders large parchment maps on the Node side with @napi-rs/canvas, reusing
 * the exact same renderer as the browser preview. Large requests are serialized
 * (one renderer at a time), size/quality/simulation resolution are chosen from
 * the requested output size, and PNG responses carry X-Atlas-* diagnostics.
 */
import { createHash } from "node:crypto";
import { freemem, totalmem } from "node:os";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import {
  DEFAULT_PARAMS,
  MAX_RENDER_SIZE,
  MIN_RENDER_SIZE,
  createPipeline,
  type Pipeline,
  type WorldDocument,
} from "@atlas/core";
import {
  RENDERER_VERSION,
  getRenderFonts,
  renderSvg,
  renderWorld,
  type Ctx2D,
  type RenderStats,
} from "@atlas/render";
import { installNodeFonts, type NodeFontInstallResult } from "@atlas/render/node-fonts";
import { encodeCanvasPng } from "@atlas/render/png";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RENDER_SIZE = 4096;
const LARGE_RENDER_SIZE = 8192;
/** 8192² is opt-in only: it needs ~1GB peak memory for the export pipeline. */
const LARGE_RENDER_ENABLED = process.env.ATLAS_ALLOW_LARGE === "1";
const SIM_MAX = Math.max(512, Math.min(2048, Number(process.env.ATLAS_SIM_MAX ?? 2048)));
const MAX_QUEUE = 2;
const RENDERER_TIMEOUT_MS = Number(process.env.ATLAS_RENDER_TIMEOUT_MS ?? 0);

const startedAt = Date.now();

// ── Fonts: guarded registration; falls back to a system serif if needed ────
const fontInfo: NodeFontInstallResult = installNodeFonts(GlobalFonts);

// A single pipeline instance keeps core's stage cache warm for repeated
// exports of the same document (e.g. style tweaks followed by re-export).
let pipeline: Pipeline = createPipeline();

interface RenderRequestBody {
  document?: WorldDocument;
  size?: number;
  allowLarge?: boolean;
}

interface RenderResult {
  png: Buffer;
  stats: RenderStats;
  simSize: number;
  simMs: number;
  renderMs: number;
  encodeMs: number;
  totalMs: number;
  pngEncoder: string;
  seed: number;
}

class QueueFullError extends Error {
  statusCode = 429;
}

/** Client closed the connection before the render finished. */
class ClientAbortError extends Error {
  statusCode = 499;
  code = "CLIENT_ABORTED";
  constructor() {
    super("client closed request");
  }
}

// ── Small renderer concurrency guard ──────────────────────────────────────
let activeRenders = 0;
let completedRenders = 0;
let abortedRenders = 0;
let lastRenderMs: number | null = null;
interface QueueWaiter {
  grant: () => void;
  reject: (error: Error) => void;
  isClientGone: () => boolean;
}
const queue: QueueWaiter[] = [];

function acquireSlot(isClientGone: () => boolean = () => false): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const grant = (): void => {
      activeRenders += 1;
      resolve(() => {
        activeRenders -= 1;
        // Hand the slot to the next *live* waiter; aborted waiters are dropped
        // immediately so a gone client never keeps the renderer busy.
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          if (next.isClientGone()) {
            abortedRenders += 1;
            next.reject(new ClientAbortError());
            continue;
          }
          next.grant();
          return;
        }
      });
    };
    if (activeRenders === 0 && queue.length === 0) {
      if (isClientGone()) {
        reject(new ClientAbortError());
        return;
      }
      grant();
    } else if (queue.length >= MAX_QUEUE) {
      reject(new QueueFullError("renderer busy, retry shortly"));
    } else {
      queue.push({
        grant,
        reject: (error: Error) => reject(error),
        isClientGone,
      });
    }
  });
}

function now(): number {
  return performance.now();
}

/** Simulation grid size chosen from the requested output size (512..2048). */
export function simSizeFor(size: number): number {
  const scaled = size <= 512 ? 512 : size <= 1024 ? 1024 : 2048;
  return Math.max(512, Math.min(SIM_MAX, scaled));
}

/** Rough peak-memory estimate (bytes) for one export at this size. */
function estimatePeakBytes(size: number, simSize: number): number {
  const pixels = size * size;
  const simCells = simSize * simSize;
  // canvas + ImageData + PNG scanline copy + compressed output + sim layers/fields
  return pixels * 14 + simCells * 190;
}

function validateDocument(document: WorldDocument | undefined): string | null {
  if (!document || typeof document !== "object") return "document is required";
  if (document.version !== 1) return "document.version must be 1";
  if (!Number.isFinite(document.seed)) return "document.seed must be a finite number";
  if (!document.params || typeof document.params !== "object") return "document.params is required";
  const params = document.params as unknown as Record<string, unknown>;
  const seaLevel = params.seaLevel;
  if (typeof seaLevel !== "number" || !Number.isFinite(seaLevel) || seaLevel <= 0 || seaLevel >= 1) {
    return "document.params.seaLevel must be within (0, 1)";
  }
  if (params.gridSize !== undefined && (!Number.isFinite(params.gridSize) || (params.gridSize as number) < 32)) {
    return "document.params.gridSize must be >= 32";
  }
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    const value = params[key];
    if (value === undefined) continue;
    const expected = typeof (DEFAULT_PARAMS as unknown as Record<string, unknown>)[key];
    if (typeof value !== expected) return `document.params.${key} must be a ${expected}`;
  }
  if (!document.style || typeof document.style !== "object") return "document.style is required";
  if (document.labels !== undefined && !Array.isArray(document.labels)) return "document.labels must be an array";
  if (document.settlements !== undefined && !Array.isArray(document.settlements)) {
    return "document.settlements must be an array";
  }
  if (document.overrides !== undefined && typeof document.overrides !== "object") {
    return "document.overrides must be an object";
  }
  return null;
}

function qualityFor(size: number): "preview" | "export" {
  return size >= 2048 ? "export" : "preview";
}

async function renderPng(
  document: WorldDocument,
  size: number,
  quality: "preview" | "export",
  simSize: number,
  isClientGone: () => boolean,
): Promise<RenderResult> {
  const release = await acquireSlot(isClientGone);
  const totalStart = now();
  try {
    // The client may have closed while this request was waiting in the queue.
    if (isClientGone()) throw new ClientAbortError();

    const simStart = now();
    const layers = pipeline.generate({ document, size: simSize });
    const simMs = now() - simStart;
    if (isClientGone()) throw new ClientAbortError();

    let canvas: Canvas | null = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    const renderStart = now();
    const stats = renderWorld({
      ctx: ctx as unknown as Ctx2D,
      width: size,
      height: size,
      document,
      layers,
      quality,
    });
    const renderMs = now() - renderStart;

    // Yield one event-loop turn so a socket `close` / request `aborted` event
    // queued while the synchronous render blocked the loop is observed before
    // paying for a large PNG encode.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (isClientGone()) throw new ClientAbortError();

    const encodeStart = now();
    // Skia's encoder is fine for preview sizes; the fast zlib path keeps the
    // 4096²/8192² export inside the latency budget.
    const useFastEncoder = size >= 2048;
    const png = useFastEncoder
      ? encodeCanvasPng(
          canvas as unknown as { width: number; height: number; data(): Uint8Array },
          { filter: "up", level: size >= 8192 ? 1 : 4 },
        )
      : canvas.toBuffer("image/png");
    const encodeMs = now() - encodeStart;

    // Drop the large native surface / context references before returning; the
    // caller only keeps the PNG buffer, so 4096/8192 exports do not accumulate.
    const nativeCanvas = canvas as unknown as { width: number; height: number };
    void nativeCanvas;
    canvas = null;
    void layers;

    return {
      png,
      stats,
      simSize,
      simMs,
      renderMs,
      encodeMs,
      totalMs: now() - totalStart,
      pngEncoder: useFastEncoder ? "zlib-up" : "skia",
      seed: document.seed,
    };
  } finally {
    release();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("render timed out"), { statusCode: 504 })), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── Fastify app ───────────────────────────────────────────────────────────
const app = Fastify({
  logger: { level: process.env.ATLAS_LOG_LEVEL ?? "info" },
  bodyLimit: MAX_BODY_BYTES,
  disableRequestLogging: true,
});

await app.register(cors, { origin: true });

function capabilities() {
  return {
    minRenderSize: MIN_RENDER_SIZE,
    maxRenderSize: MAX_RENDER_SIZE,
    defaultRenderSize: DEFAULT_RENDER_SIZE,
    largeRenderSize: LARGE_RENDER_SIZE,
    /** 8192² is opt-in per request: body.allowLarge=true (and a memory preflight). */
    largeRenderOptIn: "body.allowLarge=true",
    largeRenderEnvDefault: LARGE_RENDER_ENABLED,
    largeRenderAvailable: true,
    simRange: { min: 512, max: SIM_MAX },
    qualityModes: { preview: "< 2048", export: ">= 2048" },
    presets: ["parchment-classic", "aged-ink"],
    pngEncoders: ["skia", "zlib-up-filter"],
    vectorExport: {
      formats: ["svg"],
      endpoint: "/api/export/svg",
      physicalSizes: true,
    },
  };
}

app.get("/api/health", async () => ({
  ok: true,
  service: "atlas-forge-server",
  version: "0.1.0",
  node: process.version,
  uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  renderer: {
    version: RENDERER_VERSION,
    backend: "@napi-rs/canvas",
    fontFamily: getRenderFonts().resolvedFamily,
  },
  fonts: {
    source: fontInfo.source,
    family: fontInfo.family,
    assetDir: fontInfo.assetDir,
    files: fontInfo.loadedFiles.length,
    errors: fontInfo.errors,
  },
  capabilities: capabilities(),
  limits: {
    maxBodyBytes: MAX_BODY_BYTES,
    maxConcurrentRenders: 1,
    maxQueue: MAX_QUEUE,
    renderTimeoutMs: RENDERER_TIMEOUT_MS || null,
  },
  rendererState: {
    active: activeRenders,
    queued: queue.length,
    completed: completedRenders,
    aborted: abortedRenders,
    lastRenderMs,
  },
  memory: {
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    freeMb: Math.round(freemem() / 1048576),
    totalMb: Math.round(totalmem() / 1048576),
  },
}));

interface SvgRequestBody {
  document: WorldDocument;
  size?: number;
  physical?: { dpi?: number; widthMm?: number; heightMm?: number };
}

/**
 * Vector export: the same generator + the same layout extraction as the PNG
 * renderer, emitted as a standalone SVG. Layer geometry (coastlines, rivers
 * with Strahler-derived widths, lakes, labels, frame decorations) is produced
 * by the shared renderer, so PNG and SVG never drift apart.
 */
app.post<{ Body: SvgRequestBody }>("/api/export/svg", async (request, reply) => {
  const body = request.body;
  if (!body || typeof body !== "object") {
    return reply.code(400).send({ error: "invalid request body", code: "INVALID_BODY" });
  }
  const documentError = validateDocument(body.document);
  if (documentError) {
    return reply.code(400).send({ error: documentError, code: "INVALID_DOCUMENT" });
  }
  const document = body.document as WorldDocument;

  let size = DEFAULT_RENDER_SIZE;
  if (body.size !== undefined) {
    if (typeof body.size !== "number" || !Number.isFinite(body.size)) {
      return reply.code(400).send({ error: "size must be a finite number", code: "INVALID_SIZE" });
    }
    size = Math.round(body.size);
  }
  if (size < MIN_RENDER_SIZE || size > MAX_RENDER_SIZE) {
    return reply.code(400).send({
      error: `size must be within ${MIN_RENDER_SIZE}..${MAX_RENDER_SIZE}`,
      code: "INVALID_SIZE",
    });
  }
  // SVG scales without raster cost; allow the large size without the 8192 memory
  // preflight because only geometry is retained.
  const physical =
    body.physical && typeof body.physical === "object"
      ? {
          ...(typeof body.physical.dpi === "number" ? { dpi: body.physical.dpi } : {}),
          ...(typeof body.physical.widthMm === "number" ? { widthMm: body.physical.widthMm } : {}),
          ...(typeof body.physical.heightMm === "number" ? { heightMm: body.physical.heightMm } : {}),
        }
      : undefined;

  const started = now();
  try {
    const simSize = simSizeFor(size);
    const simStart = now();
    const layers = pipeline.generate({ document, size: simSize });
    const simMs = now() - simStart;
    const renderStart = now();
    const svg = renderSvg({
      document,
      layers,
      width: size,
      height: size,
      quality: qualityFor(size),
      ...(physical ? { physical } : {}),
    });
    const renderMs = now() - renderStart;
    const bytes = Buffer.byteLength(svg, "utf8");
    request.log.info({ size, simSize, bytes, totalMs: now() - started }, "svg export completed");
    return reply
      .header("Content-Type", "image/svg+xml; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="atlas-${document.seed}-${size}.svg"`)
      .header("X-Atlas-Sim-Size", String(simSize))
      .header("X-Atlas-Sim-Ms", String(Math.round(simMs)))
      .header("X-Atlas-Render-Ms", String(Math.round(renderMs)))
      .header("X-Atlas-Total-Ms", String(Math.round(now() - started)))
      .header("X-Atlas-Svg-Bytes", String(bytes))
      .header("X-Atlas-Renderer-Version", RENDERER_VERSION)
      .send(svg);
  } catch (error) {
    request.log.error({ err: error }, "svg export failed");
    return reply.code(500).send({
      error: error instanceof Error ? error.message : String(error),
      code: "SVG_EXPORT_FAILED",
    });
  }
});

app.head("/api/render", async (_request, reply) => {
  const caps = capabilities();
  reply
    .header("X-Atlas-Max-Size", String(caps.maxRenderSize))
    .header("X-Atlas-Default-Size", String(caps.defaultRenderSize))
    .header("X-Atlas-Sim-Range", `${caps.simRange.min}-${caps.simRange.max}`)
    .header("X-Atlas-Large-Enabled", String(LARGE_RENDER_ENABLED))
    .header("X-Atlas-Renderer-Version", RENDERER_VERSION)
    .header("X-Atlas-Font", getRenderFonts().resolvedFamily);
  return reply.code(200).send();
});

app.post<{ Body: RenderRequestBody }>("/api/render", async (request, reply) => {
  const body = request.body;
  if (!body || typeof body !== "object") {
    return reply.code(400).send({ error: "invalid request body", code: "INVALID_BODY" });
  }

  const documentError = validateDocument(body.document);
  if (documentError) {
    return reply.code(400).send({ error: documentError, code: "INVALID_DOCUMENT" });
  }
  const document = body.document as WorldDocument;

  let size = DEFAULT_RENDER_SIZE;
  if (body.size !== undefined) {
    if (typeof body.size !== "number" || !Number.isFinite(body.size)) {
      return reply.code(400).send({ error: "size must be a finite number", code: "INVALID_SIZE" });
    }
    size = Math.round(body.size);
  }
  if (size < MIN_RENDER_SIZE || size > MAX_RENDER_SIZE) {
    return reply.code(400).send({
      error: `size must be within ${MIN_RENDER_SIZE}..${MAX_RENDER_SIZE}`,
      code: "INVALID_SIZE",
    });
  }
  const wantsLarge = size > DEFAULT_RENDER_SIZE;
  const largeAllowed = LARGE_RENDER_ENABLED || body.allowLarge === true;
  if (wantsLarge && !largeAllowed) {
    return reply.code(413).send({
      error:
        `size ${size} exceeds the safe default ${DEFAULT_RENDER_SIZE}. ` +
        "Retry with {\"allowLarge\": true} (8192² is an explicit opt-in) or request 4096.",
      code: "LARGE_RENDER_DISABLED",
      maxSafeSize: DEFAULT_RENDER_SIZE,
    });
  }

  const simSize = simSizeFor(size);
  const estimatedPeak = estimatePeakBytes(size, simSize);
  const available = freemem();
  if (estimatedPeak > available * 0.85) {
    return reply.code(507).send({
      error:
        `request would need ~${Math.round(estimatedPeak / 1048576)}MB but only ` +
        `${Math.round(available / 1048576)}MB is free; retry a smaller size.`,
      code: "INSUFFICIENT_MEMORY",
      estimatedPeakMb: Math.round(estimatedPeak / 1048576),
      availableMb: Math.round(available / 1048576),
    });
  }

  const quality = qualityFor(size);
  const started = now();

  // Client-abort tracking: if the socket closes while we wait in the queue or
  // during the synchronous render, the request is dropped as soon as the render
  // yields (before the expensive PNG encode) so it never blocks the renderer.
  let clientAborted = false;
  const markAborted = (): void => {
    if (!reply.raw.writableEnded) clientAborted = true;
  };
  reply.raw.once("close", markAborted);
  request.raw.once("aborted", markAborted);
  request.raw.once("close", () => {
    // Normal requests also emit `close` after the body is consumed; only a
    // pre-response close with an incomplete message means the client vanished.
    if (!request.raw.complete) markAborted();
  });
  const isClientGone = (): boolean =>
    clientAborted || request.raw.aborted === true || request.raw.socket?.destroyed === true;

  if (isClientGone()) {
    abortedRenders += 1;
    request.log.info({ size, simSize }, "client gone before render started");
    try {
      reply.raw.destroy();
    } catch {
      // socket already gone
    }
    return reply;
  }

  try {
    const result = await withTimeout(
      renderPng(document, size, quality, simSize, isClientGone),
      RENDERER_TIMEOUT_MS,
    );
    if (isClientGone()) {
      abortedRenders += 1;
      request.log.info(
        {
          size,
          simSize,
          totalMs: Math.round(result.totalMs),
          droppedBytes: result.png.length,
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
        },
        "client aborted; rendered PNG dropped before send",
      );
      try {
        reply.raw.destroy();
      } catch {
        // socket already gone
      }
      return reply;
    }
    completedRenders += 1;
    lastRenderMs = Math.round(result.totalMs);
    const documentHash = createHash("sha1")
      .update(JSON.stringify({ seed: document.seed, params: document.params, style: document.style }))
      .digest("hex")
      .slice(0, 12);
    request.log.info(
      {
        size,
        simSize,
        quality,
        simMs: Math.round(result.simMs),
        renderMs: Math.round(result.renderMs),
        encodeMs: Math.round(result.encodeMs),
        totalMs: Math.round(result.totalMs),
        bytes: result.png.length,
        seed: document.seed,
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
      },
      "render completed",
    );
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", "no-store")
      .header("X-Atlas-Size", String(size))
      .header("X-Atlas-Sim-Size", String(result.simSize))
      .header("X-Atlas-Quality", quality)
      .header("X-Atlas-Preset", result.stats.preset)
      .header("X-Atlas-Renderer-Version", result.stats.version)
      .header("X-Atlas-Font", result.stats.fontFamily)
      .header("X-Atlas-Png-Encoder", result.pngEncoder)
      .header("X-Atlas-Seed", String(result.seed))
      .header("X-Atlas-Land-Fraction", result.stats.landFraction.toFixed(4))
      .header("X-Atlas-Sim-Ms", String(Math.round(result.simMs)))
      .header("X-Atlas-Render-Ms", String(Math.round(result.renderMs)))
      .header("X-Atlas-Encode-Ms", String(Math.round(result.encodeMs)))
      .header("X-Atlas-Total-Ms", String(Math.round(result.totalMs)))
      .header("X-Atlas-Document-Hash", documentHash)
      .header("X-Atlas-Request-Ms", String(Math.round(now() - started)))
      .send(result.png);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 499 || isClientGone()) {
      abortedRenders += 1;
      request.log.info({ size, simSize, totalMs: Math.round(now() - started) }, "render aborted by client");
      try {
        reply.raw.destroy();
      } catch {
        // socket already gone
      }
      return reply;
    }
    request.log.error({ err: error, size, simSize }, "render failed");
    return reply.code(statusCode).send({
      error: error instanceof Error ? error.message : String(error),
      code: statusCode === 429 ? "RENDERER_BUSY" : statusCode === 504 ? "RENDER_TIMEOUT" : "RENDER_FAILED",
    });
  }
});

app.setErrorHandler((error, request, reply) => {
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  if (statusCode >= 500) request.log.error({ err: error }, "request failed");
  const message =
    statusCode === 413
      ? `request body exceeds ${Math.round(MAX_BODY_BYTES / 1024)}KB`
      : error instanceof Error
        ? error.message
        : String(error);
  const code =
    statusCode === 413
      ? "BODY_TOO_LARGE"
      : /JSON/i.test(message)
        ? "INVALID_JSON"
        : "ERROR";
  return reply.code(statusCode).send({ error: message, code });
});

await app.listen({ port: PORT, host: HOST });
console.log(
  `Atlas Forge API listening on http://${HOST}:${PORT}  renderer=${RENDERER_VERSION}  ` +
    `fonts=${fontInfo.family}(${fontInfo.source})  large=${LARGE_RENDER_ENABLED}`,
);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`received ${signal}, shutting down`);
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
