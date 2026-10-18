/** PNG export dialog: local 1024/2048, backend 4096/8192, graceful fallback. */
import { useEffect, useRef, useState } from "react";

import { EXPORT_PRESETS, type ExportPreset } from "../lib/constants";
import { exportLocalPng, exportServerPng, pngFilename, ExportError } from "../lib/exportPng";
import { refreshServerStatus } from "../lib/api";
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

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const [selectedSize, setSelectedSize] = useState<number>(2048);
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [stageLabel, setStageLabel] = useState("准备导出");
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [failure, setFailure] = useState<ExportFailure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number>(0);
  const server = useWorldStore((state) => state.server);
  const preset = presetFor(selectedSize);
  const working = phase === "working";

  useEffect(() => {
    if (!open) return;
    if (phase !== "working") setPhase((current) => (current === "success" || current === "error" ? current : "idle"));
    void refreshServerStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!working) return;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 120);
    return () => window.clearInterval(timer);
  }, [working]);

  const resetFeedback = () => {
    setPhase("idle");
    setOutcome(null);
    setFailure(null);
    setProgress(0);
    setStageLabel("准备导出");
    setElapsedMs(0);
  };

  const runExport = async (size: number, mode: "local" | "server") => {
    if (working) return;
    resetFeedback();
    setPhase("working");
    startedAtRef.current = Date.now();
    const document = useWorldStore.getState().document;
    try {
      if (mode === "local") {
        const result = await exportLocalPng(document, size, (update) => {
          setStageLabel(update.stage === "done" ? "光栅化" : update.label);
          setProgress(update.progress);
        });
        const filename = downloadBlob(result.blob, pngFilename(document, size));
        setOutcome({ filename, meta: result.meta });
        setPhase("success");
        useWorldStore.getState().pushToast("success", `PNG 导出完成：${filename}`);
      } else {
        setStageLabel("服务端生成 + 渲染");
        setProgress(0.15);
        const result = await exportServerPng(document, size, {
          timeoutMs: size >= 8192 ? 180_000 : 120_000,
        });
        const filename = downloadBlob(result.blob, pngFilename(document, size));
        setOutcome({ filename, meta: result.meta });
        setPhase("success");
        useWorldStore.getState().pushToast("success", `PNG 导出完成：${filename}`);
        void refreshServerStatus();
      }
    } catch (error) {
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
    }
  };

  const fallbackToLocal = () => {
    setSelectedSize(2048);
    void runExport(2048, "local");
  };

  const footer = (
    <div className="dialog-actions">
      <button type="button" className="btn btn--ghost" onClick={onClose} data-testid="export-cancel">
        {phase === "success" ? "关闭" : "取消"}
      </button>
      <button
        type="button"
        className="btn btn--primary"
        disabled={working}
        data-testid="export-start"
        onClick={() => void runExport(selectedSize, preset.mode)}
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
      onClose={onClose}
      footer={footer}
      width={620}
      testId="export-dialog"
    >
      <div className="export-grid">
        {EXPORT_PRESETS.map((option) => (
          <button
            key={option.size}
            type="button"
            className={`export-card ${selectedSize === option.size ? "is-selected" : ""}`}
            aria-pressed={selectedSize === option.size}
            data-testid={`export-size-${option.size}`}
            disabled={working}
            onClick={() => {
              setSelectedSize(option.size);
              resetFeedback();
            }}
          >
            <span className="export-card-size">{option.label}</span>
            <span className="export-card-note">{option.note}</span>
            <span className="export-card-mode">
              {option.mode === "local" ? "本地渲染" : "服务端渲染"} · {option.estimate}
            </span>
          </button>
        ))}
      </div>

      <div className="export-summary">
        <div className="export-summary-row">
          <span>输出尺寸</span>
          <strong>
            {preset.size} × {preset.size} · {((preset.size * preset.size) / 1_000_000).toFixed(1)} MP
          </strong>
        </div>
        <div className="export-summary-row">
          <span>渲染方式</span>
          <strong>{preset.mode === "local" ? "浏览器离屏 Canvas（Web Worker）" : "POST /api/render（Node + @napi-rs/canvas）"}</strong>
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

      {preset.mode === "server" && server.phase === "offline" ? (
        <div className="dialog-warning" data-testid="export-server-warning">
          导出服务当前不可用。4096 / 8192 需要 Node API（`pnpm dev` 会同时启动 8787）。
          你仍可尝试，或改用 1024 / 2048 本地导出。
        </div>
      ) : null}

      {phase === "working" ? (
        <div className="export-progress" data-testid="export-progress">
          <ProgressBar value={preset.mode === "server" ? 0.45 : progress} />
          <div className="export-progress-meta">
            <span>{stageLabel}…</span>
            <span>{formatMs(elapsedMs)}</span>
          </div>
        </div>
      ) : null}

      {phase === "success" && outcome ? (
        <div className="dialog-success" data-testid="export-result">
          <strong>导出完成：{outcome.filename}</strong>
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
        服务不可用时会明确提示并保留本地导出作为降级出口。
      </p>
    </Modal>
  );
}
