/**
 * Worker client with latest-wins scheduling.
 *
 * Only one generation job runs at a time; while it runs, newer requests
 * replace the pending document instead of queueing up. Stale worker responses
 * are discarded by comparing sequence ids.
 */
import type { ProgressUpdate, WorldDocument, WorldLayers } from "@atlas/core";

export interface GenerationClientHandlers {
  onDispatch(seq: number, document: WorldDocument): void;
  onQueued(seq: number, document: WorldDocument): void;
  onProgress(seq: number, update: ProgressUpdate): void;
  onLayers(seq: number, layers: WorldLayers, document: WorldDocument): void;
  onError(seq: number, message: string): void;
}

interface WorkerLayersMessage {
  type: "layers";
  seq: number;
  layers: WorldLayers;
  document: WorldDocument;
}

interface WorkerProgressMessage {
  type: "progress";
  seq: number;
  update: ProgressUpdate;
}

interface WorkerErrorMessage {
  type: "error";
  seq: number;
  message: string;
}

type WorkerReply = WorkerLayersMessage | WorkerProgressMessage | WorkerErrorMessage;

interface Job {
  seq: number;
  document: WorldDocument;
}

export class GenerationClient {
  private worker: Worker | null = null;
  private handlers: GenerationClientHandlers;
  private seqCounter = 0;
  private inFlightSeq = 0;
  private busy = false;
  private pending: Job | null = null;
  private currentDocument: WorldDocument | null = null;

  constructor(handlers: GenerationClientHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    if (this.worker) return;
    const worker = new Worker(new URL("../worker/worldWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.handleMessage(event.data);
    worker.onerror = (event: ErrorEvent) => {
      const seq = this.inFlightSeq;
      this.finish();
      this.handlers.onError(seq, event.message || "生成 worker 崩溃");
      this.pumpPending();
    };
    this.worker = worker;
  }

  /** Submit a document. Returns the sequence id associated with this request. */
  request(document: WorldDocument): number {
    this.seqCounter += 1;
    const job: Job = { seq: this.seqCounter, document };
    if (!this.worker) {
      this.handlers.onError(job.seq, "生成 worker 尚未启动");
      return job.seq;
    }
    if (this.busy) {
      if (this.currentDocument === document) return this.inFlightSeq;
      if (this.pending?.document === document) return this.pending.seq;
      this.pending = job;
      this.handlers.onQueued(job.seq, document);
      return job.seq;
    }
    this.dispatch(job);
    return job.seq;
  }

  /** Ask the worker to drop any cached pipeline stages (used after import). */
  reset(): void {
    this.worker?.postMessage({ type: "reset" });
  }

  terminate(): void {
    this.busy = false;
    this.inFlightSeq = 0;
    this.currentDocument = null;
    this.pending = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }

  private dispatch(job: Job): void {
    this.busy = true;
    this.inFlightSeq = job.seq;
    this.currentDocument = job.document;
    this.handlers.onDispatch(job.seq, job.document);
    this.worker?.postMessage({ type: "generate", seq: job.seq, document: job.document });
  }

  private finish(): void {
    this.busy = false;
    this.inFlightSeq = 0;
    this.currentDocument = null;
  }

  private pumpPending(): void {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    this.dispatch(job);
  }

  private handleMessage(message: WorkerReply): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "progress") {
      if (message.seq !== this.inFlightSeq) return;
      this.handlers.onProgress(message.seq, message.update);
      return;
    }
    if (message.type === "layers") {
      if (message.seq !== this.inFlightSeq) return;
      this.finish();
      this.handlers.onLayers(message.seq, message.layers, message.document);
      this.pumpPending();
      return;
    }
    if (message.type === "error") {
      if (message.seq !== this.inFlightSeq) return;
      this.finish();
      this.handlers.onError(message.seq, message.message);
      this.pumpPending();
    }
  }
}
