/// <reference lib="es2022" />
/**
 * World generation worker.
 *
 * Protocol (request ids are named `seq`):
 *   main → worker: { type: "generate", seq, document } | { type: "reset" }
 *   worker → main: { type: "progress", seq, update }
 *                  { type: "layers", seq, layers, document }  (buffers transferred)
 *                  { type: "error", seq, message }
 *
 * The pipeline instance is kept between requests so core-side stage caching can
 * kick in; "reset" drops those caches (used after importing a world).
 */
import {
  createPipeline,
  type Pipeline,
  type ProgressUpdate,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";

interface GenerateRequest {
  type: "generate";
  seq: number;
  document: WorldDocument;
}

interface ResetRequest {
  type: "reset";
}

type IncomingMessage = GenerateRequest | ResetRequest;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

let pipeline: Pipeline = createPipeline();
let lastProgressAt = 0;

function transferables(layers: WorldLayers): Transferable[] {
  const arrays = [
    layers.height,
    layers.filled,
    layers.ocean,
    layers.lake,
    layers.river,
    layers.flow,
    layers.temperature,
    layers.moisture,
    layers.biome,
  ];
  const buffers: Transferable[] = [];
  for (const array of arrays) {
    const buffer = array?.buffer;
    if (buffer instanceof ArrayBuffer) buffers.push(buffer);
  }
  return buffers;
}

function postProgress(seq: number, update: ProgressUpdate): void {
  const now = Date.now();
  // Throttle progress chatter to ~25 fps; always let terminal stages through.
  if (update.stage !== "done" && update.stage !== "human" && now - lastProgressAt < 40) {
    return;
  }
  lastProgressAt = now;
  workerScope.postMessage({ type: "progress", seq, update });
}

workerScope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "reset") {
    pipeline.dispose();
    pipeline = createPipeline();
    return;
  }

  if (message.type !== "generate") return;
  const { seq, document } = message;
  lastProgressAt = 0;
  try {
    const layers = pipeline.generate({
      document,
      onProgress: (update: ProgressUpdate) => postProgress(seq, update),
    });
    workerScope.postMessage({ type: "layers", seq, layers, document }, transferables(layers));
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      seq,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
