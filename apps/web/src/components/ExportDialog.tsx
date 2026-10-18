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
import { exportSvg, getClientSvgRenderer, hasSvgExport } from "../lib/exportSvg";
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

const SVG_PRINT_HINTS: Record<number, string> = {
  1024: "A6 @300dpi",
  2048: "A5 @300dpi",
  4096: "A3 @300dpi",
  8192: "A1 @300dpi",
};

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

  const [format, setFormat] = useState<"png" | "svg">("png");
  const [svgReady, setSvgReady] = useState<boolean | null>(null);
  const [svgClientMode, setSvgClientMode] = useState<boolean>(false);
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
  const selectedNeedsServer = format === "png" && preset.mode === "server";
  const svgNeedsServer = format === "svg" && !svgClientMode;
  const disabledReason = (() => {
    if (generationActive) return "正在生成世界，请等待完成后再导出";
    if (format === "svg") {
      if (svgReady === null) return "正在检测 SVG 导出能力…";
      if (svgReady === false) return "SVG 导出不可用：渲染器与服务端均未就绪，可回退 PNG";
      if (svgNeedsServer && serverOffline) return "SVG 需要服务端渲染，当前离线，可回退 PNG";
      return null;
    }
    if (selectedNeedsServer && serverOffline) return "导出服务离线：4096 / 8192 需要 Node API";
    return null;
  })();

  useEffect(() => {
    if (!open) return;
    void refreshServerStatus();
    let cancelled = false;
    void (async () => {
      const [ready, renderer] = await Promise.all([hasSvgExport(), getClientSvgRenderer()]);
      if (cancelled) return;
      setSvgReady(ready);
      setSvgClientMode(renderer !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!working) return;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 120);
    return () => window.clearInterval(timer);
  }, [working]);

  // Server-side exports have no progress events: stage the label locally.
  useEffect(() => {
    if (!working || format !== "png" || preset.mode !== "server") return;
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
  }, [working, preset.mode, format]);

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

  const runExport = async (
    size: number,
    mode: "local" | "server",
    formatOverride: "png" | "svg" = format,
  ) => {
    if (working) return;
    resetFeedback();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("working");
    startedAtRef.current = Date.now();
    const storeState = useWorldStore.getState();
    const document = storeState.document;
    try {
      if (formatOverride === "svg") {
        const result = await exportSvg(document, size, {
          signal: controller.signal,
          layers: storeState.layers,
          onProgress: (update) => {
            setStageLabel(update.stage);
            setStageIndex(-1);
            setProgress(update.progress);
          },
        });
        if (controller.signal.aborted) throw new ExportError("cancelled", "已取消导出");
        const filename = downloadBlob(result.blob, result.filename);
        setOutcome({
          filename,
          meta: {
            size,
            simSize: null,
            totalMs: result.meta.totalMs,
            simMs: null,
            renderMs: result.meta.renderMs,
            fontsReady: null,
          },
        });
        setPhase("success");
        setProgress(1);
        useWorldStore.getState().pushToast("success", `SVG 导出完成：${filename}`);
        return;
      }
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
      const usedServer = formatOverride === "svg" ? !svgClientMode : mode === "server";
      setFailure({ kind, message, server: usedServer });
      setPhase("error");
      if (usedServer) {
        useWorldStore.getState().setServerStatus({
          phase: "offline",
          latencyMs: null,
          maxSize: null,
        });
      }
      useWorldStore.getState().pushToast(
        "error",
        `${formatOverride === "svg" ? "SVG" : "PNG"} 导出失败：${message}`,
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const fallbackToLocal = () => {
    setFormat("png");
    setExportSize(2048);
    void runExport(2048, "local", "png");
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
        onClick={() =>
          void runExport(
            exportSize,
            format === "svg" ? (svgClientMode ? "local" : "server") : preset.mode,
          )
        }
      >
        {working ? "导出中…" : `导出 ${preset.label} ${format.toUpperCase()}`}
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      title={format === "svg" ? "导出 SVG（矢量）" : "导出 PNG"}
      subtitle={
        format === "svg"
          ? "矢量路径与文字，适合印刷 / Illustrator 再加工；世界 JSON 仍是唯一真源。"
          : "世界 JSON 才是唯一真源；PNG 是当前文档的渲染产物。"
      }
      onClose={handleClose}
      footer={footer}
      width={640}
      testId="export-dialog"
    >
      <div className="export-format-tabs" role="group" aria-label="导出格式">
        <button
          type="button"
          className={`export-format-tab ${format === "png" ? "is-selected" : ""}`}
          data-testid="export-format-png"
          aria-pressed={format === "png"}
          disabled={working}
          onClick={() => {
            if (format === "png") return;
            setFormat("png");
            resetFeedback();
          }}
        >
          <span className="export-format-tab-title">PNG 位图</span>
          <span className="export-format-tab-note">网页 / 社交分享 · 1024–8192 · 本地或服务端光栅</span>
        </button>
        <button
          type="button"
          className={`export-format-tab ${format === "svg" ? "is-selected" : ""}`}
          data-testid="export-format-svg"
          aria-pressed={format === "svg"}
          disabled={working || svgReady === false}
          title={svgReady === false ? "SVG 渲染器与服务端均未就绪" : "矢量路径与文字，适合印刷"}
          onClick={() => {
            if (format === "svg") return;
            setFormat("svg");
            resetFeedback();
          }}
        >
          <span className="export-format-tab-title">SVG 矢量（印刷）</span>
          <span className="export-format-tab-note">
            无限缩放 / 可编辑 · {svgClientMode ? "客户端 renderSvg" : "服务端 /api/export/svg"}
          </span>
        </button>
      </div>

      <div className="export-grid">
        {EXPORT_PRESETS.map((option) => {
          const requiresServer = option.mode === "server";
          const sizeDisabled =
            working ||
            (format === "svg"
              ? svgReady !== true
              : requiresServer && serverOffline);
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
            {exportSize}.{format === "svg" ? "svg" : "png"}
          </strong>
        </div>
        {format === "svg" ? (
          <div className="export-summary-row">
            <span>印刷参考</span>
            <strong data-testid="export-print-size">
              {SVG_PRINT_HINTS[exportSize] ?? "A3 @300dpi"} · 矢量可无损放大
            </strong>
          </div>
        ) : null}
        <div className="export-summary-row">
          <span>渲染方式</span>
          <strong>
            {format === "svg"
              ? svgClientMode
                ? "客户端 renderSvg（矢量路径 + 文字）"
                : "POST /api/export/svg（Node 矢量渲染）"
              : preset.mode === "local"
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
        {format === "svg" ? (
          <>
            SVG 优先使用客户端渲染器；不可用时走 <code>POST /api/export/svg</code>。
            矢量文件包含路径与文字，适合印刷与 Illustrator 二次编辑；文件名格式
            `atlas-&lt;世界名&gt;-&lt;种子&gt;-&lt;预设&gt;-&lt;尺寸&gt;.svg`。
          </>
        ) : (
          <>
            大图（4096 / 8192）由 Node 后端重新生成并渲染，浏览器只负责下载 blob；
            服务不可用时会明确提示并保留本地导出作为降级出口。文件名格式
            `atlas-&lt;世界名&gt;-&lt;种子&gt;-&lt;预设&gt;-&lt;尺寸&gt;.png`。
          </>
        )}
      </p>
    </Modal>
  );
}
