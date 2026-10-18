/**
 * Atlas Forge export server.
 *
 * M0: health check + large-map PNG render endpoint wired to the shared
 * pipeline/renderer. render-dev hardens limits, params, fonts and errors.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createCanvas } from "@napi-rs/canvas";
import {
  MAX_RENDER_SIZE,
  MIN_RENDER_SIZE,
  createPipeline,
  type WorldDocument,
} from "@atlas/core";
import { renderWorld, type Ctx2D } from "@atlas/render";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface RenderRequestBody {
  document: WorldDocument;
  size: number;
}

const app = Fastify({ logger: true, bodyLimit: MAX_BODY_BYTES });

await app.register(cors, { origin: true });

app.get("/api/health", async () => ({
  ok: true,
  node: process.version,
  capabilities: { maxRenderSize: MAX_RENDER_SIZE, backend: "napi-canvas" },
}));

app.post<{ Body: RenderRequestBody }>("/api/render", async (request, reply) => {
  const body = request.body;
  if (!body || typeof body !== "object" || !body.document || typeof body.size !== "number") {
    return reply.code(400).send({ error: "invalid request body" });
  }
  const rawSize = Math.round(body.size);
  if (!Number.isFinite(rawSize) || rawSize < MIN_RENDER_SIZE || rawSize > MAX_RENDER_SIZE) {
    return reply.code(400).send({ error: `size must be within ${MIN_RENDER_SIZE}..${MAX_RENDER_SIZE}` });
  }
  if (body.document.version !== 1 || typeof body.document.seed !== "number" || !body.document.params) {
    return reply.code(400).send({ error: "invalid world document" });
  }

  const startedAt = Date.now();
  const size = rawSize;
  const simSize = Math.min(2048, Math.max(512, Math.floor(size / 2)));
  try {
    const pipeline = createPipeline();
    const layers = pipeline.generate({ document: body.document, size: simSize });
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    renderWorld({
      ctx: ctx as unknown as Ctx2D,
      width: size,
      height: size,
      document: body.document,
      layers,
      quality: "export",
    });
    const png = canvas.toBuffer("image/png");
    request.log.info(
      { size, simSize, bytes: png.length, ms: Date.now() - startedAt },
      "render completed",
    );
    return reply
      .header("Content-Type", "image/png")
      .header("X-Atlas-Sim-Size", String(simSize))
      .header("X-Atlas-Render-Ms", String(Date.now() - startedAt))
      .send(png);
  } catch (error) {
    request.log.error({ err: error }, "render failed");
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`Atlas Forge API listening on http://127.0.0.1:${PORT}`);
