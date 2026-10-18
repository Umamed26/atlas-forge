import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDefaultDocument,
  type ProgressUpdate,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";
import { renderWorld, type Ctx2D } from "@atlas/render";

const PREVIEW_SIZE = 1024;

interface WorkerLayersMessage {
  type: "layers";
  requestId: number;
  layers: WorldLayers;
  document: WorldDocument;
}

interface WorkerProgressMessage {
  type: "progress";
  requestId: number;
  update: ProgressUpdate;
}

interface WorkerErrorMessage {
  type: "error";
  requestId: number;
  message: string;
}

type WorkerReply = WorkerLayersMessage | WorkerProgressMessage | WorkerErrorMessage;

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const [document, setDocument] = useState<WorldDocument>(() =>
    createDefaultDocument({ name: "Aetheris", seed: 20261018 }),
  );
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [status, setStatus] = useState("等待生成");
  const [error, setError] = useState<string | null>(null);
  const documentRef = useRef(document);
  documentRef.current = document;

  const draw = useCallback((layers: WorldLayers, doc: WorldDocument) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = PREVIEW_SIZE;
    canvas.height = PREVIEW_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderWorld({
      ctx: ctx as unknown as Ctx2D,
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      document: doc,
      layers,
      quality: "preview",
    });
  }, []);

  const requestGeneration = useCallback((doc: WorldDocument) => {
    const worker = workerRef.current;
    if (!worker) return;
    requestIdRef.current += 1;
    setStatus("生成中…");
    setError(null);
    worker.postMessage({ type: "generate", requestId: requestIdRef.current, document: doc });
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/worldWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.requestId !== requestIdRef.current) return;
      if (message.type === "progress") {
        setProgress(message.update);
        return;
      }
      if (message.type === "error") {
        setError(message.message);
        setStatus("生成失败");
        return;
      }
      draw(message.layers, message.document);
      const { totalMs, landFraction } = message.layers.stats;
      setStatus(
        `生成完成 · 用时 ${Math.round(totalMs)}ms · 陆地 ${(landFraction * 100).toFixed(1)}% · ${message.layers.settlements.length} 城镇`,
      );
      setProgress(null);
    };
    requestGeneration(documentRef.current);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [draw, requestGeneration]);

  const updateParam = (key: "seaLevel" | "continentScale" | "warpStrength" | "ridgeStrength" | "riverDensity" | "moistureBias", value: number) => {
    const next: WorldDocument = {
      ...document,
      params: { ...document.params, [key]: value },
      updatedAt: new Date().toISOString(),
    };
    setDocument(next);
    requestGeneration(next);
  };

  const reroll = () => {
    const next: WorldDocument = {
      ...document,
      seed: Math.floor(Math.random() * 1e9),
      updatedAt: new Date().toISOString(),
    };
    setDocument(next);
    requestGeneration(next);
  };

  const stats = progress ? `${progress.label} ${Math.round(progress.progress * 100)}%` : status;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✦</span>
          <h1>Atlas Forge</h1>
          <span className="badge">M0 骨架</span>
        </div>
        <div className="actions">
          <button type="button" onClick={reroll}>
            换一个种子
          </button>
        </div>
      </header>

      <main className="layout">
        <aside className="panel">
          <h2>{document.name}</h2>
          <p className="hint">种子 {document.seed}</p>
          <label className="field">
            <span>海平面 · {document.params.seaLevel.toFixed(2)}</span>
            <input
              type="range"
              min={0.2}
              max={0.7}
              step={0.01}
              value={document.params.seaLevel}
              onChange={(e) => updateParam("seaLevel", Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>大陆尺度 · {document.params.continentScale.toFixed(2)}</span>
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.05}
              value={document.params.continentScale}
              onChange={(e) => updateParam("continentScale", Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>海岸扭曲 · {document.params.warpStrength.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={document.params.warpStrength}
              onChange={(e) => updateParam("warpStrength", Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>山脉强度 · {document.params.ridgeStrength.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={document.params.ridgeStrength}
              onChange={(e) => updateParam("ridgeStrength", Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>河流密度 · {document.params.riverDensity.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={document.params.riverDensity}
              onChange={(e) => updateParam("riverDensity", Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>湿度偏差 · {document.params.moistureBias.toFixed(2)}</span>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.01}
              value={document.params.moistureBias}
              onChange={(e) => updateParam("moistureBias", Number(e.target.value))}
            />
          </label>
          <div className="status-box">
            <strong>{stats}</strong>
            {error ? <p className="error">{error}</p> : null}
          </div>
        </aside>

        <section className="stage">
          <div className="canvas-frame">
            <canvas ref={canvasRef} className="map-canvas" />
          </div>
        </section>
      </main>
    </div>
  );
}
