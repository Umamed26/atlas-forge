/**
 * PNG export dialog.
 *
 * - 1024 / 2048 render locally in a Worker (cancellable, real progress).
 * - 4096 / 8192 render on the Node backend (cancellable fetch, staged progress).
 * - The selected size lives in the store so the top bar button reflects it, and
 *   the chosen size is persisted across sessions.
 */
import { useEffect, useRef, useState } from "react";

import { EXPORT_PRESETS, type ExportPreset } from "../lib/constants";
import { refreshServerStatus } from "../lib/api";
import { ExportError, exportLocalPng, exportServerPng, pngFilename } from "../lib/exportPng";
import { downloadBlob, formatMs } from "../lib/utils";
import { useWorldStore } from "../state/worldStore";
import { Modal, ProgressBar } from "./ui";

type ExportPhase = "idle" | "working" | "success" | "error";

interface ExportOutcome {
  filename: string;
  meta: {
    size: number;
    simSize: number | null;
    totalMs: number | null;
    simMs: number | null;
    renderMs: number | null;
    fontsReady: boolean | null;
  };
}

interface ExportFailure {
  kind: string;
  message: string;
  server: boolean;
}

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

function presetFor(size: number): ExportPreset {
  return EXPORT_PRESETS.find((preset) => preset.size === size) ?? EXPORT_PRESETS[1];
}

const SERVER_STAGES = ["上传世界数据", "服务端生成", "服务端渲染", "下载 PNG"];

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const exportSize = useWorldStore((state) => state.exportSize);
  const documentName = useWorldStore((state) => state.document.name);
  const documentSeed = useWorldStore((state) => state.document.seed);
  const presetId = useWorldStore((state) => state.document.style.preset);
  const setExportSize = useWorldStore((state) => state.setExportSize);
  const server = useWorldStore((state) => state.server);
  const generationActive = useWorldStore(
    (state) =>
      state.generation.phase === "generating" ||
      state.generation.phase === "queued" ||
      state.render.rendering,
  );

  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [stageLabel, setStageLabel] = useState("准备导出");
  const [stageIndex, setStageIndex] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [failure, setFailure] = useState<ExportFailure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const preset = presetFor(exportSize);
  const working = phase === "working";

  const serverOffline = server.phase === "offline";
  const selectedNeedsServer = preset.mode === "server";
  const disabledReason = (() => {
    if (generationActive) return "正在生成世界，请等待完成后再导出";
    if (selectedNeedsServer && serverOffline) return "导出服务离线：4096 / 8192 需要 Node API";
    return null;
  })();

  useEffect(() => {
    if (!open) return;
    void refreshServerStatus();
  }, [open]);

  useEffect(() => {
    if (!working) return;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 120);
    return () => window.clearInterval(timer);
  }, [working]);

  // Server-side exports have no progress events: stage the label locally.
  useEffect(() => {
    if (!working || preset.mode !== "server") return;
    let index = 0;
    setStageIndex(0);
    setStageLabel(SERVER_STAGES[0]);
    setProgress(0.08);
    const timer = window.setInterval(() => {
      index = Math.min(SERVER_STAGES.length - 1, index + 1);
      setStageIndex(index);
      setStageLabel(SERVER_STAGES[index]);
      setProgress(Math.min(0.85, 0.08 + index * 0.22));
    }, 1400);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, preset.mode]);

  // Abort any in-flight export when the dialog unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const resetFeedback = () => {
    setPhase("idle");
    setOutcome(null);
    setFailure(null);
    setProgress(0);
    setStageLabel("准备导出");
    setStageIndex(-1);
    setElapsedMs(0);
    setCancelReason(null);
  };

  const cancelExport = (notify = true) => {
    if (!working) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setStageLabel("已取消导出");
    setProgress(0);
    setCancelReason("已取消导出");
    if (notify) useWorldStore.getState().pushToast("info", "已取消导出");
  };

  const handleClose = () => {
    if (working) cancelExport(false);
    onClose();
  };

  const runExport = async (size: number, mode: "local" | "server") => {
    if (working) return;
    resetFeedback();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("working");
    startedAtRef.current = Date.now();
    const document = useWorldStore.getState().document;
    try {
      if (mode === "local") {
        const result = await exportLocalPng(
          document,
          size,
          (update) => {
            setStageLabel(update.stage === "done" ? "光栅化" : update.label);
            setStageIndex(-1);
            setProgress(update.progress);
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) throw new ExportError("cancelled", "已取消导出");
        const filename = downloadBlob(result.blob, pngFilename(document, size));
        setOutcome({ filename, meta: result.meta });
        setPhase("success");
        setProgress(1);
        useWorldStore.getState().pushToast("success", `PNG 导出完成：${filename}`);
      } else {
        const result = await exportServerPng(document, size, {
          timeoutMs: size >= 8192 ? 180_000 : 120_000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new ExportError("cancelled", "已取消导出");
        const filename = downloadBlob(result.blob, pngFilename(document, size));
        setOutcome({ filename, meta: result.meta });
        setPhase("success");
        setProgress(1);
        useWorldStore.getState().pushToast("success", `PNG 导出完成：${filename}`);
        void refreshServerStatus();
      }
    } catch (error) {
      if (error instanceof ExportError && error.kind === "cancelled") {
        setPhase("idle");
        setStageLabel("已取消导出");
        setProgress(0);
        setCancelReason("已取消导出");
        return;
      }
      const kind = error instanceof ExportError ? error.kind : "render";
      const message = error instanceof Error ? error.message : String(error);
      setFailure({ kind, message, server: mode === "server" });
      setPhase("error");
      if (mode === "server") {
        useWorldStore.getState().setServerStatus({
          phase: "offline",
          latencyMs: null,
          maxSize: null,
        });
      }
      useWorldStore.getState().pushToast("error", `PNG 导出失败：${message}`);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const fallbackToLocal = () => {
    setExportSize(2048);
    void runExport(2048, "local");
  };

  const footer = (
    <div className="dialog-actions">
      {working ? (
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="export-cancel-running"
          onClick={() => cancelExport()}
        >
          取消导出
        </button>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={handleClose} data-testid="export-cancel">
          {phase === "success" ? "关闭" : "取消"}
        </button>
      )}
      <button
        type="button"
        className="btn btn--primary"
        disabled={working || disabledReason !== null}
        title={disabledReason ?? undefined}
        data-testid="export-start"
        onClick={() => void runExport(exportSize, preset.mode)}
      >
        {working ? "导出中…" : `导出 ${preset.label} PNG`}
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      title="导出 PNG"
      subtitle="世界 JSON 才是唯一真源；PNG 是当前文档的渲染产物。"
      onClose={handleClose}
      footer={footer}
      width={640}
      testId="export-dialog"
    >
      <div className="export-grid">
        {EXPORT_PRESETS.map((option) => {
          const requiresServer = option.mode === "server";
          const sizeDisabled = working || (requiresServer && serverOffline);
          return (
            <button
              key={option.size}
              type="button"
              className={`export-card ${exportSize === option.size ? "is-selected" : ""}`}
              aria-pressed={exportSize === option.size}
              aria-disabled={sizeDisabled}
              data-testid={`export-size-${option.size}`}
              disabled={sizeDisabled}
              onClick={() => {
                if (sizeDisabled) return;
                setExportSize(option.size);
                resetFeedback();
              }}
            >
              <span className="export-card-size">{option.label}</span>
              <span className="export-card-note">{option.note}</span>
              <span className="export-card-mode">
                {requiresServer
                  ? serverOffline
                    ? "服务端离线 · 需 Node API"
                    : "服务端渲染"
                  : "本地渲染"}{" "}
                · {option.estimate}
              </span>
            </button>
          );
        })}
      </div>

      <div className="export-summary">
        <div className="export-summary-row" data-testid="export-filename-preview">
          <span>输出尺寸</span>
          <strong data-testid="export-size-summary">
            {preset.size} × {preset.size} · {((preset.size * preset.size) / 1_000_000).toFixed(1)} MP
          </strong>
        </div>
        <div className="export-summary-row">
          <span>文件名</span>
          <strong data-testid="export-filename">
            atlas-{documentName || "world"}-{documentSeed}-{presetId === "aged-ink" ? "aged-ink" : "parchment"}-
            {exportSize}.png
          </strong>
        </div>
        <div className="export-summary-row">
          <span>渲染方式</span>
          <strong>
            {preset.mode === "local"
              ? "浏览器离屏 Canvas（Web Worker）"
              : "POST /api/render（Node + @napi-rs/canvas）"}
          </strong>
        </div>
        <div className="export-summary-row">
          <span>导出服务</span>
          <strong data-testid="export-server-status">
            {server.phase === "online"
              ? `在线${server.latencyMs !== null ? ` · ${Math.round(server.latencyMs)}ms` : ""}`
              : server.phase === "offline"
                ? "离线"
                : "探测中…"}
          </strong>
        </div>
      </div>

      {disabledReason ? (
        <div className="dialog-warning" data-testid="export-disabled-reason">
          {disabledReason}
          {selectedNeedsServer && serverOffline ? " 可改用 1024 / 2048 本地导出。" : null}
        </div>
      ) : null}

      {working ? (
        <div className="export-progress" data-testid="export-progress">
          <ProgressBar value={progress} />
          <div className="export-progress-meta">
            <span data-testid="export-progress-stage">
              {stageLabel}
              {stageIndex >= 0 ? `（${stageIndex + 1}/${SERVER_STAGES.length}）` : ""}…
            </span>
            <span data-testid="export-progress-percent">{Math.round(progress * 100)}%</span>
            <span>{formatMs(elapsedMs)}</span>
          </div>
        </div>
      ) : null}

      {phase === "idle" && cancelReason ? (
        <div className="dialog-warning" data-testid="export-cancelled">
          {cancelReason}
        </div>
      ) : null}

      {phase === "success" && outcome ? (
        <div className="dialog-success" data-testid="export-result">
          <strong data-testid="export-result-filename">导出完成：{outcome.filename}</strong>
          <span>
            用时 {formatMs(outcome.meta.totalMs)}
            {outcome.meta.simMs !== null ? ` · 模拟 ${formatMs(outcome.meta.simMs)}` : ""}
            {outcome.meta.renderMs !== null ? ` · 渲染 ${formatMs(outcome.meta.renderMs)}` : ""}
            {outcome.meta.simSize !== null ? ` · 模拟网格 ${outcome.meta.simSize}²` : ""}
            {outcome.meta.fontsReady !== null
              ? ` · 字体 EB Garamond ${outcome.meta.fontsReady ? "已加载" : "回退"}`
              : ""}
          </span>
        </div>
      ) : null}

      {phase === "error" && failure ? (
        <div className="dialog-error" data-testid="export-error">
          <strong>导出失败</strong>
          <span>{failure.message}</span>
          {failure.server ? (
            <button
              type="button"
              className="btn btn--small"
              data-testid="export-fallback-local"
              onClick={fallbackToLocal}
            >
              改用 2048 本地导出
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="dialog-note">
        大图（4096 / 8192）由 Node 后端重新生成并渲染，浏览器只负责下载 blob；
        服务不可用时会明确提示并保留本地导出作为降级出口。文件名格式
        `atlas-&lt;世界名&gt;-&lt;种子&gt;-&lt;预设&gt;-&lt;尺寸&gt;.png`。
      </p>
    </Modal>
  );
}
