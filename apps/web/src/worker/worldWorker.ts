/// <reference lib="es2022" />
import { createPipeline } from "@atlas/core";
import type { GenerateOptions, Pipeline, ProgressUpdate, WorldDocument } from "@atlas/core";

interface GenerateRequest {
  type: "generate";
  requestId: number;
  document: WorldDocument;
}

type IncomingMessage = GenerateRequest;

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const pipeline: Pipeline = createPipeline();

workerScope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type !== "generate") return;
  const { requestId, document } = message;
  try {
    const layers = pipeline.generate({
      document,
      onProgress: (update: ProgressUpdate) => {
        workerScope.postMessage({ type: "progress", requestId, update });
      },
    });
    const transfer: Transferable[] = [
      layers.height.buffer,
      layers.filled.buffer,
      layers.ocean.buffer,
      layers.lake.buffer,
      layers.river.buffer,
      layers.flow.buffer,
      layers.temperature.buffer,
      layers.moisture.buffer,
      layers.biome.buffer,
    ] as Transferable[];
    workerScope.postMessage({ type: "layers", requestId, layers, document }, transfer);
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
